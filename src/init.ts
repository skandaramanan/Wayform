/** Installer entry — full implementation in Task 5. */
export async function runInit(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    process.stdout.write(
      "memorylayer init — wire MemoryLayer into this project\n",
    );
    return;
  }
  throw new Error("memorylayer init is not implemented yet");
}
