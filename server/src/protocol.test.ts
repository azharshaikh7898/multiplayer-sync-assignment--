import { parseClientMessage } from "./protocol.js";

const cases = [
  { type: "cursor", clientId: "abc", seq: 1, x: 10, y: 20 },        // valid
  { type: "cursor", clientId: "abc", seq: 1, x: "10", y: 20 },      // invalid: x is string
  { type: "reaction", clientId: "abc", seq: 1, x: 1, y: 1, reaction: "🔥" }, // valid
  { type: "nonsense", clientId: "abc" },                            // invalid: unknown type
  { clientId: "abc" },                                              // invalid: no type
  null,                                                              // invalid
  "just a string",                                                   // invalid
];

for (const c of cases) {
  console.log(JSON.stringify(c), "→", parseClientMessage(c));
}