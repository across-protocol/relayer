import readline from "readline";

async function askQuestion(query: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) =>
    rl.question(query, (ans) => {
      rl.close();
      resolve(ans);
    })
  );
}

export async function askYesNoQuestion(query: string): Promise<boolean> {
  const ans = (await askQuestion(`${query} (y/n) `)) as string;
  if (ans.toLowerCase() === "y") {
    return true;
  }
  if (ans.toLowerCase() === "n") {
    return false;
  }
  return askYesNoQuestion(query);
}
