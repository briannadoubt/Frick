import { writeNativeArtifacts } from "../src/artifacts.js";
import { foundationSchema } from "../src/foundation.js";

const written = writeNativeArtifacts({ rootDir: process.cwd(), schema: foundationSchema });

console.log(`Wrote ${written.swiftPath}`);
console.log(`Wrote ${written.kotlinPath}`);
