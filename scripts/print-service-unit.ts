import { serviceUnit } from "./server-service.js";

const node = process.argv[2];
if (!node) throw new Error("usage: print-service-unit <absolute-node-path>");
process.stdout.write(serviceUnit(node));
