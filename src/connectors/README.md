# Connector contract

The copy engine never talks to a broker directly. Each platform (ProjectX, Tradovate, Rithmic, …)
gets a **connector**: an `EventEmitter` with the methods and events below. Adding a platform =
writing one new file here. The engine does not change.

## Properties
- `id`: unique connection id (string)
- `type`: `'projectx' | 'sim' | 'tradovate' | ...`
- `label`: human name
- `status`: `'disconnected' | 'connecting' | 'connected' | 'error'`

## Methods (all async)
| Method | Returns |
|---|---|
| `connect()` / `disconnect()` | – |
| `listAccounts()` | `[{ id, name, balance, canTrade }]` |
| `getContract(contractId)` | `{ id, name, tickSize, tickValue } \| null` |
| `getPositions(accountId)` | `[{ contractId, net, avgPrice }]` (net is signed: + long, − short) |
| `getOpenOrders(accountId)` | `[NormalizedOrder]` |
| `placeOrder(req)` | `{ orderId }` (req: `{ accountId, contractId, type, side, size, limitPrice?, stopPrice?, trailPrice?, customTag? }`) |
| `modifyOrder({ accountId, orderId, size?, limitPrice?, stopPrice?, trailPrice? })` | – |
| `cancelOrder({ accountId, orderId })` | – |
| `closePosition({ accountId, contractId })` | – |
| `partialClose({ accountId, contractId, size })` | – |
| `watchContract(contractId)` | start streaming quotes for it (may no-op) |

## Events
| Event | Payload |
|---|---|
| `order` | `NormalizedOrder`: `{ accountId, orderId, contractId, status, type, side, size, limitPrice, stopPrice, trailPrice, filledPrice, fillVolume, customTag }` |
| `position` | `{ accountId, contractId, net, avgPrice }` |
| `quote` | `{ contractId, price }` |
| `status` | `{ status, error? }` |
| `resynced` | after a reconnect: the engine re-reads positions |

Normalized values:
- `type`: `market | limit | stop | stopLimit | trailingStop | joinBid | joinAsk`
- `side`: `buy | sell`
- `status`: `pending | open | filled | cancelled | expired | rejected`
