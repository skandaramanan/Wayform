export function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      shortCircuit: true,
      url: new URL("./cloudflare-workers-stub.mjs", import.meta.url).href,
    };
  }
  return nextResolve(specifier, context);
}
