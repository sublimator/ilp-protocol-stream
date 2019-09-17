# ILP/STREAM
> Interledger Transport Protocol for sending multiple streams of money and data over ILP.

[![NPM Package](https://img.shields.io/npm/v/ilp-protocol-stream.svg?style=flat)](https://npmjs.org/package/ilp-protocol-stream)
[![CircleCI](https://circleci.com/gh/interledgerjs/ilp-protocol-stream.svg?style=shield)](https://circleci.com/gh/interledgerjs/ilp-protocol-stream)
[![codecov](https://codecov.io/gh/interledgerjs/ilp-protocol-stream/branch/master/graph/badge.svg)](https://codecov.io/gh/interledgerjs/ilp-protocol-stream)
[![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com)
[![Known Vulnerabilities](https://snyk.io/test/github/interledgerjs/ilp-protocol-stream/badge.svg)](https://snyk.io/test/github/interledgerjs/ilp-protocol-stream) [![Greenkeeper badge](https://badges.greenkeeper.io/interledgerjs/ilp-protocol-stream.svg)](https://greenkeeper.io/)
[![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Finterledgerjs%2Filp-protocol-stream.svg?type=shield)](https://app.fossa.io/projects/git%2Bgithub.com%2Finterledgerjs%2Filp-protocol-stream?ref=badge_shield)

STREAM is the recommended Transport Protocol to use for most Interledger applications.

The protocol allows a "client" and "server" to establish a bidirectional connection through Interledger that can be used to send money and data. This module handles authentication, encryption, flow control (making sure one party doesn't send more than the other can handle at once), and congestion control (avoiding sending more packets than the network can handle).

## Install

Requires Node >= v8.10.

```sh
npm install ilp-protocol-stream
```

## Usage

These snippets assume you are running a local [`moneyd`](https://github.com/interledgerjs/moneyd-xrp).

You'll need [`ilp-plugin`](https://github.com/interledgerjs/ilp-plugin) to run the example.

```sh
npm install ilp-plugin
```

See [example.js](./example.js) for a runnable example, or paste the snippets into your own node project below. You'll need to provide a means of getting the shared secret from Server to Client.

**Client:**

Clients connect with the `destinationAccount` and `sharedSecret` generated by a Server.

```js
const { createConnection } = require('ilp-protocol-stream')
const getPlugin = require('ilp-plugin')

const { destinationAccount, sharedSecret } = getThisFromTheServerSomehow()

async function run () {
  const connection = await createConnection({
    plugin: getPlugin(),
    destinationAccount,
    sharedSecret
  })

  const stream = connection.createStream()
  stream.write('hello\n')
  stream.write('here is some more data')
  await stream.sendTotal(100)
  await stream.sendTotal(200)
  stream.end()
}

run().catch((err) => console.log(err))
```

**Server:**

```js
const { createServer } = require('ilp-protocol-stream')
const getPlugin = require('ilp-plugin')

async function run () {
  const server = await createServer({
    plugin: getPlugin()
  })

  // These need to be passed to the client through an authenticated communication channel
  const { destinationAccount, sharedSecret } = await server.generateAddressAndSecret()

  server.on('connection', (connection) => {
    connection.on('stream', (stream) => {

      // Set the maximum amount of money this stream can receive
      stream.setReceiveMax(10000)

      stream.on('money', (amount) => {
        console.log(`got money: ${amount} on stream ${stream.id}`)
      })

      stream.on('data', (chunk) => {
        console.log(`got data on stream ${stream.id}: ${chunk.toString('utf8')}`)
      })

      stream.on('end', () => {
        console.log('stream closed')
      })
    })
  })
}

run().catch((err) => console.log(err))
```

## API

See the full API docs at: https://interledgerjs.github.io/ilp-protocol-stream

The most important functions and classes to look at are:
- [`createConnection`](https://interledgerjs.github.io/ilp-protocol-stream/modules/_index_.html#createconnection) - open a Connection to a Server
- [`Server`](https://interledgerjs.github.io/ilp-protocol-stream/classes/_index_.server.html) - class used to listen for incoming Connections
- [`Connection`](https://interledgerjs.github.io/ilp-protocol-stream/classes/_connection_.connection.html) - class that manages the communication between a Client and a Server
- [`DataAndMoneyStream`](https://interledgerjs.github.io/ilp-protocol-stream/classes/_stream_.dataandmoneystream.html) - stream class that can be used to send/receive data and money

## Contribute

PRs, new ideas, and questions are very welcome!

Please feel free to [open issues](https://github.com/interledgerjs/ilp-protocol-stream/issues/new) to discuss any problems you run into or suggestions you have.

## License

Apache-2.0

[![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Finterledgerjs%2Filp-protocol-stream.svg?type=large)](https://app.fossa.io/projects/git%2Bgithub.com%2Finterledgerjs%2Filp-protocol-stream?ref=badge_large)
