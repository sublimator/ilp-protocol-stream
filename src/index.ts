import { EventEmitter } from 'events'
import * as ILDCP from 'ilp-protocol-ildcp'
import * as IlpPacket from 'ilp-packet'
import createLogger from 'ilp-logger'
import './util/formatters'
import * as cryptoHelper from './crypto'
import { buildConnection, Connection, ConnectionOpts } from './connection'
import { ServerConnectionPool } from './pool'
import { Plugin } from './util/plugin-interface'

const CONNECTION_ID_REGEX = /^[a-zA-Z0-9~_-]+$/

export { Connection } from './connection'
export { DataAndMoneyStream } from './stream'
export { Server, ServerOpts, createServer } from './server'

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
  const connection = await buildConnection({
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
      log.error('got data that is not an ILP Prepare packet: %h', data)
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
