export async function promptPassword(label = "密码："): Promise<string> {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) { value += String(chunk); if (value.length > 1024) throw new Error("password-too-long"); }
    return value.replace(/\r?\n$/, "");
  }
  process.stdout.write(label);
  const input = process.stdin, wasRaw = input.isRaw;
  input.setRawMode(true); input.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      input.off("data", receive); input.setRawMode(wasRaw); input.pause(); process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const receive = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\u0003") { finish(new Error("input-cancelled")); return; }
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " " && value.length < 128) value += char;
      }
    };
    input.on("data", receive);
  });
}
