// Browser-safe stand-in for `chalk`, aliased in vite.config.ts.
//
// The engine only touches chalk on a console-rendering path we never invoke,
// but chalk itself pulls in Node-only builtins that break the browser build.
// This Proxy makes every property access return a callable that ignores any
// styling and returns the input string(s) unchanged, so `chalk.red.bold("x")`,
// `chalk("x")`, `chalk.hex("#fff")("x")`, etc. all just yield the text.

const stringify = (args: unknown[]): string => args.map(String).join("");

const handler: ProxyHandler<(...args: unknown[]) => string> = {
  get: () => proxy,
  apply: (_target, _thisArg, args: unknown[]) => stringify(args),
};

const proxy: any = new Proxy(function () {} as any, handler);

export default proxy;
export const Chalk = function () {
  return proxy;
} as unknown as new () => typeof proxy;
export const chalkStderr = proxy;
export const supportsColor = false;
export const supportsColorStderr = false;
