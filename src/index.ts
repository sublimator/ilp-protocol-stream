import { EventEmitter } from 'events'
import * as ILDCP from 'ilp-protocol-ildcp'
import * as IlpPacket from 'ilp-packet'
import createLogger from 'ilp-logger'
import * as cryptoHelper from './crypto'
import { randomBytes } from 'crypto'
import { Connection, ConnectionOpts } from './connection'
import { Plugin } from './util/plugin-interface'
require('source-map-support').install()

const CONNECTION_ID_REGEX = /^[a-zA-Z0-9_-]+$/

export { Connection } from './connection'
export { DataAndMoneyStream } from './stream'

export interface CreateConnectionOpts extends ConnectionOpts {
  /** ILP Address of the server */
  destinationAccount: string,
  /** Shared secret generated by the server */
  sharedSecret: Buffer
}

/**
 * Create a [`Connection`]{@link Connection} to a [`Server`]{@link Server} using the `destinationAccount` and `sharedSecret` provided.
 */
export async function createConnection (opts: CreateConnectionOpts): Promise<Connection> {
  const plugin = opts.plugin
  await plugin.connect()
  const log = createLogger('ilp-protocol-stream:Client')
  const { clientAddress, assetCode, assetScale } = await ILDCP.fetch(plugin.sendData.bind(plugin))
  const connection = new Connection({
    ...opts,
    sourceAccount: clientAddress,
    assetCode,
    assetScale,
    isServer: false,
    plugin
  })
  plugin.registerDataHandler(async (data: Buffer): Promise<Buffer> => {
    let prepare: IlpPacket.IlpPrepare
    try {
      prepare = IlpPacket.deserializeIlpPrepare(data)
    } catch (err) {
      log.error(`got data that is not an ILP Prepare packet: ${data.toString('hex')}`)
      return IlpPacket.serializeIlpReject({
        code: 'F00',
        message: `Expected an ILP Prepare packet (type 12), but got packet with type: ${data[0]}`,
        data: Buffer.alloc(0),
        triggeredBy: clientAddress
      })
    }

    try {
      const fulfill = await connection.handlePrepare(prepare)
      return IlpPacket.serializeIlpFulfill(fulfill)
    } catch (err) {
      if (!err.ilpErrorCode) {
        log.error('error handling prepare:', err)
      }
      // TODO should the default be F00 or T00?
      return IlpPacket.serializeIlpReject({
        code: err.ilpErrorCode || 'F00',
        message: err.ilpErrorMessage || '',
        data: err.ilpErrorData || Buffer.alloc(0),
        triggeredBy: clientAddress
      })
    }
  })
  connection.once('close', () => {
    plugin.deregisterDataHandler()
    plugin.disconnect()
      .then(() => log.info('plugin disconnected'))
      .catch((err: Error) => log.error('error disconnecting plugin:', err))
  })
  await connection.connect()
  // TODO resolve only when it is connected
  return connection
}

export interface ServerOpts extends ConnectionOpts {
  serverSecret?: Buffer
  /** Don't send data or money over this connection. False by default */
  receiveOnly?: boolean
}

/**
 * STREAM Server that can listen on an account and handle multiple incoming [`Connection`s]{@link Connection}.
 * Note: the connections this refers to are over ILP, not over the Internet.
 *
 * The Server operator should give a unique address and secret (generated by calling
 * [`generateAddressAndSecret`]{@link generateAddressAndSecret}) to each client that it expects to connect.
 *
 * The Server will emit a `'connection'` event when the first packet is received for a specific Connection.
 */
export class Server extends EventEmitter {
  protected serverSecret: Buffer
  protected plugin: Plugin
  protected serverAccount: string
  protected serverAssetCode: string
  protected serverAssetScale: number
  protected connections: { [key: string]: Connection }
  protected closedConnections: { [key: string]: boolean }
  protected log: any
  protected enablePadding?: boolean
  protected connected: boolean
  protected connectionOpts: ConnectionOpts

  constructor ({ serverSecret, ...opts }: ServerOpts) {
    super()
    this.serverSecret = serverSecret || randomBytes(32)
    this.plugin = opts.plugin
    this.log = createLogger('ilp-protocol-stream:Server')
    this.connections = {}
    this.closedConnections = {}
    this.connectionOpts = opts
    this.connected = false
  }

  /**
   * Event fired when a new [`Connection`]{@link Connection} is received
   * @event connection
   * @type {Connection}
   */

  /**
   * Connect the plugin and start listening for incoming connections.
   *
   * When a new connection is accepted, the server will emit the "connection" event.
   *
   * @fires connection
   */
  async listen (): Promise<void> {
    if (this.connected && this.plugin.isConnected()) {
      return
    }
    this.plugin.registerDataHandler(this.handleData.bind(this))
    await this.plugin.connect()
    const { clientAddress, assetCode, assetScale } = await ILDCP.fetch(this.plugin.sendData.bind(this.plugin))
    this.serverAccount = clientAddress
    this.serverAssetCode = assetCode
    this.serverAssetScale = assetScale
    this.connected = true
  }

  /**
   * End all connections and disconnect the plugin
   */
  async close (): Promise<void> {
    await Promise.all(Object.keys(this.connections).map((id: string) => {
      return this.connections[id].end()
    }))

    this.plugin.deregisterDataHandler()
    await this.plugin.disconnect()
    this.connected = false
  }

  /**
   * Resolves when the next connection is accepted.
   *
   * To handle subsequent connections, the user must call `acceptConnection` again.
   * Alternatively, the user can listen on the `'connection'` event.
   */
  async acceptConnection (): Promise<Connection> {
    await this.listen()
    /* tslint:disable-next-line:no-unnecessary-type-assertion */
    return new Promise((resolve, reject) => {
      this.once('connection', resolve)
    }) as Promise<Connection>
  }

  /**
   * Generate an address and secret for a specific client to enable them to create a connection to the server.
   *
   * Two different clients SHOULD NOT be given the same address and secret.
   *
   * @param connectionTag Optional connection identifier that will be appended to the ILP address and can be used to identify incoming connections. Can only include characters that can go into an ILP Address
   */
  generateAddressAndSecret (connectionTag?: string): { destinationAccount: string, sharedSecret: Buffer } {
    if (!this.connected) {
      throw new Error('Server must be connected to generate address and secret')
    }
    let token = base64url(cryptoHelper.generateToken())
    if (connectionTag) {
      if (!CONNECTION_ID_REGEX.test(connectionTag)) {
        throw new Error('connectionTag can only include ASCII characters a-z, A-Z, 0-9, "_", and "-"')
      }
      token = token + '~' + connectionTag
    }
    const sharedSecret = cryptoHelper.generateSharedSecretFromToken(this.serverSecret, Buffer.from(token, 'ascii'))
    return {
      // TODO should this be called serverAccount or serverAddress instead?
      destinationAccount: `${this.serverAccount}.${token}`,
      sharedSecret
    }
  }

  get assetCode (): string {
    if (!this.connected) {
      throw new Error('Server must be connected to get asset code.')
    }
    return this.serverAssetCode
  }

  get assetScale (): number {
    if (!this.connected) {
      throw new Error('Server must be connected to get asset scale.')
    }
    return this.serverAssetScale
  }

  /**
   * Parse incoming ILP Prepare packets and pass them to the correct connection
   */
  protected async handleData (data: Buffer): Promise<Buffer> {
    try {
      let prepare: IlpPacket.IlpPrepare
      try {
        prepare = IlpPacket.deserializeIlpPrepare(data)
      } catch (err) {
        this.log.error(`got data that is not an ILP Prepare packet: ${data.toString('hex')}`)
        return IlpPacket.serializeIlpReject({
          code: 'F00',
          message: `Expected an ILP Prepare packet (type 12), but got packet with type: ${data[0]}`,
          data: Buffer.alloc(0),
          triggeredBy: this.serverAccount
        })
      }

      const localAddressParts = prepare.destination.replace(this.serverAccount + '.', '').split('.')
      if (localAddressParts.length === 0 || !localAddressParts[0]) {
        this.log.error(`destination in ILP Prepare packet does not have a Connection ID: ${prepare.destination}`)
        /* Why no error message here?
        We return an empty message here because we want to minimize the amount of information sent unencrypted
        that identifies this protocol and specific implementation for the rest of the network. For example,
        if every implementation returns a slightly different message here, you could determine what type of
        endpoint is listening on a particular ILP address just by changing the last character of the destination
        in a packet and seeing what error message you get back.
        Apologies if this caused additional debugging time for you! */
        throw new IlpPacket.Errors.UnreachableError('')
      }
      const connectionId = localAddressParts[0]

      if (this.closedConnections[connectionId]) {
        this.log.debug(`got packet for connection that was already closed: ${connectionId}`)
        // See "Why no error message here?" note above
        throw new IlpPacket.Errors.UnreachableError('')
      }

      if (!this.connections[connectionId]) {
        let sharedSecret
        try {
          const token = Buffer.from(connectionId, 'ascii')
          sharedSecret = cryptoHelper.generateSharedSecretFromToken(this.serverSecret, token)
          cryptoHelper.decrypt(sharedSecret, prepare.data)
        } catch (err) {
          this.log.error(`got prepare for an address and token that we did not generate: ${prepare.destination}`)
          // See "Why no error message here?" note above
          throw new IlpPacket.Errors.UnreachableError('')
        }

        // If we get here, that means it was a token + sharedSecret we created
        const connectionTag = (connectionId.indexOf('~') !== -1 ? connectionId.slice(connectionId.indexOf('~') + 1) : undefined)
        const connection = new Connection({
          ...this.connectionOpts,
          sourceAccount: this.serverAccount,
          assetCode: this.serverAssetCode,
          assetScale: this.serverAssetScale,
          sharedSecret,
          isServer: true,
          connectionTag,
          plugin: this.plugin
        })
        this.connections[connectionId] = connection
        this.log.debug(`got incoming packet for new connection: ${connectionId}${(connectionTag ? ' (connectionTag: ' + connectionTag + ')' : '')}`)
        try {
          this.emit('connection', connection)
        } catch (err) {
          this.log.error('error in connection event handler:', err)
        }

        connection.once('close', () => {
          delete this.connections[connectionId]
          this.closedConnections[connectionId] = true
        })

        // Wait for the next tick of the event loop before handling the prepare
        await new Promise((resolve, reject) => setImmediate(resolve))
      }

      const fulfill = await this.connections[connectionId].handlePrepare(prepare)
      return IlpPacket.serializeIlpFulfill(fulfill)

    } catch (err) {
      if (!err.ilpErrorCode) {
        this.log.error('error handling prepare:', err)
      }
      // TODO should the default be F00 or T00?
      return IlpPacket.serializeIlpReject({
        code: err.ilpErrorCode || 'F00',
        message: err.ilpErrorMessage || '',
        data: err.ilpErrorData || Buffer.alloc(0),
        triggeredBy: this.serverAccount || ''
      })
    }
  }
}

/**
 * Creates a [`Server`]{@link Server} and resolves when the server is connected and listening
 */
export async function createServer (opts: ServerOpts): Promise<Server> {
  const server = new Server(opts)
  await server.listen()
  return server
}

function base64url (buffer: Buffer) {
  return buffer.toString('base64')
    .replace(/=+$/, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}
