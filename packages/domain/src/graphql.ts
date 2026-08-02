// The warm-plane contract (architecture §7.3): the schema lives in domain so
// server and client read one text. Order events are the §5.6 FIX vocabulary;
// enum value names match the TS unions exactly, so no mapping layer exists to
// drift. All operations ride one WebSocket (ADR-05) — the place a production
// system would split HTTP/WS is marked in the client wiring, not here.

export const GRAPHQL_SCHEMA_SDL = /* GraphQL */ `
  enum Side {
    buy
    sell
  }

  enum TimeInForce {
    DAY
    IOC
  }

  enum ExecType {
    NEW
    TRADE
    REJECTED
    CANCELED
    EXPIRED
  }

  enum OrdStatus {
    NEW
    PARTIALLY_FILLED
    FILLED
    REJECTED
    CANCELED
    EXPIRED
  }

  enum RejectReason {
    LAST_LOOK
    STALE_PRICE
    INVALID_QTY
    CREDIT
  }

  input OrderInput {
    "Client order id; server-issued when omitted."
    clOrdId: ID
    "Six-letter pair symbol, e.g. EURUSD."
    pair: String!
    side: Side!
    "Thousands of base currency, like every size on the wire."
    qtyK: Int!
    tif: TimeInForce! = DAY
  }

  "The immediate answer: accepted for processing. Outcomes arrive as events."
  type SubmitAck {
    clOrdId: ID!
    "Milliseconds on the simulation clock."
    receivedAt: Float!
  }

  "One §5.6 event: execType says what happened, ordStatus what the order is now."
  type ExecutionReport {
    clOrdId: ID!
    "Enriched from the order's registration, so a blotter needs no local registry."
    pair: String!
    side: Side!
    orderQtyK: Int!
    "Dense per-order event number, stamped at publish — the §6.2 idea on the warm plane: a hole is provable loss, a repeat is a provable duplicate."
    eventSeq: Int!
    execType: ExecType!
    ordStatus: OrdStatus!
    "Fill price in pipettes; TRADE only."
    lastPx: Int
    "Fill size in K; TRADE only."
    lastQty: Int
    cumQty: Int!
    leavesQty: Int!
    rejectReason: RejectReason
    transactTime: Float!
  }

  """
  Current state of one order — the reconnect snapshot (ADR-08 retold on the
  warm plane): after a drop the client takes state wholesale and resumes
  events; eventSeq says which events this state already contains.
  """
  type OrderState {
    clOrdId: ID!
    pair: String!
    side: Side!
    orderQtyK: Int!
    ordStatus: OrdStatus!
    cumQty: Int!
    leavesQty: Int!
    "Price of the latest fill in pipettes."
    lastPx: Int
    rejectReason: RejectReason
    "Events folded into this state; a report with eventSeq at or below is already inside."
    eventSeq: Int!
    "Sim-clock ms of the latest folded event."
    updatedAt: Float!
  }

  "A completed fill, flattened for the blotter."
  type Trade {
    clOrdId: ID!
    pair: String!
    side: Side!
    qtyK: Int!
    "Fill price in pipettes."
    priceP: Int!
    transactTime: Float!
  }

  "Server-side position: values that change only on trade events (§7.3)."
  type Position {
    pair: String!
    "Signed net quantity in K; positive = long base."
    netQtyK: Int!
    "Average entry price in pipettes."
    avgPx: Float!
    "Realised P&L in quote units of one K, from closed quantity."
    realisedPnl: Float!
  }

  type Query {
    trades(pair: String): [Trade!]!
    positions: [Position!]!
    "Every order's current state — the warm plane's snapshot-on-reconnect."
    orders: [OrderState!]!
  }

  type Mutation {
    submitOrder(input: OrderInput!): SubmitAck!
  }

  type Subscription {
    "Every event exactly once, in order; never merged, never dropped (§7.3)."
    executionReports(clOrdId: ID): ExecutionReport!
  }
`;
