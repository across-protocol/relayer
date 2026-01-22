import * as fs from "fs";
import * as path from "path";

const filePath = "./inventoryConfig.json";
const absolutePath = path.resolve(filePath);

if (fs.existsSync(absolutePath)) {
  console.log(`✓ File exists: ${absolutePath}`);
  console.log("--- Content ---");
  const content = fs.readFileSync(absolutePath, "utf-8");
  console.log(content);
} else {
  console.log(`✗ File does not exist: ${absolutePath}`);
}

