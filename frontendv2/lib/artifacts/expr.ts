// Safe math-expression compiler for interactive artifacts.
//
// Interactive widgets receive an expression string from the model (e.g.
// "a*sin(b*x + c) + d"). We must never eval()/new Function() untrusted output,
// so this module parses a small grammar and compiles it to a closure tree.
//
// Supported: numbers, x, declared params, + - * / ^, unary +/-,
// parentheses, implicit multiplication (2x, 3sin(x)), and a whitelist of
// functions/constants. Anything else throws at compile time.

export type EvalFn = (x: number, params: Record<string, number>) => number;

type Node =
  | { k: "num"; v: number }
  | { k: "var"; name: string }
  | { k: "call"; name: string; args: Node[] }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "neg"; a: Node };

type Token =
  | { t: "num"; v: number }
  | { t: "ident"; v: string }
  | { t: "op"; v: string };

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const FUNCS: Record<string, { arity: number | -1; fn: (...a: number[]) => number }> = {
  sin: { arity: 1, fn: Math.sin },
  cos: { arity: 1, fn: Math.cos },
  tan: { arity: 1, fn: Math.tan },
  asin: { arity: 1, fn: Math.asin },
  acos: { arity: 1, fn: Math.acos },
  atan: { arity: 1, fn: Math.atan },
  sinh: { arity: 1, fn: Math.sinh },
  cosh: { arity: 1, fn: Math.cosh },
  tanh: { arity: 1, fn: Math.tanh },
  sqrt: { arity: 1, fn: Math.sqrt },
  abs: { arity: 1, fn: Math.abs },
  exp: { arity: 1, fn: Math.exp },
  ln: { arity: 1, fn: Math.log },
  log: { arity: 1, fn: Math.log10 },
  floor: { arity: 1, fn: Math.floor },
  ceil: { arity: 1, fn: Math.ceil },
  round: { arity: 1, fn: Math.round },
  sign: { arity: 1, fn: Math.sign },
  min: { arity: -1, fn: Math.min },
  max: { arity: -1, fn: Math.max },
  pow: { arity: 2, fn: Math.pow },
};

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n") {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j += 1;
      const raw = src.slice(i, j);
      const v = Number(raw);
      if (!Number.isFinite(v)) throw new Error(`无法解析数字 "${raw}"`);
      out.push({ t: "num", v });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      out.push({ t: "ident", v: src.slice(i, j).toLowerCase() });
      i = j;
      continue;
    }
    if ("+-*/^(),".includes(ch)) {
      out.push({ t: "op", v: ch });
      i += 1;
      continue;
    }
    throw new Error(`不支持的字符 "${ch}"`);
  }
  return out;
}

class Parser {
  private pos = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly params: ReadonlySet<string>,
  ) {}

  parse(): Node {
    const node = this.expr();
    if (this.pos < this.tokens.length) {
      throw new Error("表达式末尾有多余内容");
    }
    return node;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private eatOp(v: string): boolean {
    const tok = this.peek();
    if (tok?.t === "op" && tok.v === v) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectOp(v: string): void {
    if (!this.eatOp(v)) throw new Error(`缺少 "${v}"`);
  }

  private expr(): Node {
    let node = this.term();
    for (;;) {
      if (this.eatOp("+")) node = { k: "bin", op: "+", a: node, b: this.term() };
      else if (this.eatOp("-")) node = { k: "bin", op: "-", a: node, b: this.term() };
      else return node;
    }
  }

  private term(): Node {
    let node = this.unary();
    for (;;) {
      if (this.eatOp("*")) {
        node = { k: "bin", op: "*", a: node, b: this.unary() };
        continue;
      }
      if (this.eatOp("/")) {
        node = { k: "bin", op: "/", a: node, b: this.unary() };
        continue;
      }
      // Implicit multiplication: "2x", "3sin(x)", "(x+1)(x-1)".
      if (this.startsPrimary()) {
        node = { k: "bin", op: "*", a: node, b: this.unary() };
        continue;
      }
      return node;
    }
  }

  private startsPrimary(): boolean {
    const tok = this.peek();
    if (!tok) return false;
    if (tok.t === "num" || tok.t === "ident") return true;
    return tok.t === "op" && tok.v === "(";
  }

  private unary(): Node {
    if (this.eatOp("-")) return { k: "neg", a: this.unary() };
    if (this.eatOp("+")) return this.unary();
    return this.power();
  }

  private power(): Node {
    const base = this.primary();
    if (this.eatOp("^")) {
      // Right-associative, and the exponent may be signed: 2^-x
      return { k: "bin", op: "^", a: base, b: this.unary() };
    }
    return base;
  }

  private primary(): Node {
    const tok = this.peek();
    if (!tok) throw new Error("表达式不完整");

    if (tok.t === "num") {
      this.pos += 1;
      return { k: "num", v: tok.v };
    }

    if (tok.t === "ident") {
      this.pos += 1;
      const name = tok.v;
      if (name in FUNCS) {
        const fn = FUNCS[name];
        this.expectOp("(");
        const args: Node[] = [];
        if (!this.eatOp(")")) {
          args.push(this.expr());
          while (this.eatOp(",")) args.push(this.expr());
          this.expectOp(")");
        }
        if (fn.arity !== -1 && args.length !== fn.arity) {
          throw new Error(`${name}() 需要 ${fn.arity} 个参数`);
        }
        return { k: "call", name, args };
      }
      if (name === "x") return { k: "var", name };
      if (name in CONSTANTS) return { k: "num", v: CONSTANTS[name] };
      if (this.params.has(name)) return { k: "var", name };
      throw new Error(`未知变量 "${name}"（可用的参数：${[...this.params].join(", ") || "无"}）`);
    }

    if (tok.t === "op" && tok.v === "(") {
      this.pos += 1;
      const inner = this.expr();
      this.expectOp(")");
      return inner;
    }

    throw new Error(`意外的符号 "${tok.v}"`);
  }
}

function compileNode(node: Node): EvalFn {
  switch (node.k) {
    case "num":
      return () => node.v;
    case "var":
      if (node.name === "x") return (x) => x;
      return (_x, params) => params[node.name] ?? 0;
    case "neg": {
      const inner = compileNode(node.a);
      return (x, p) => -inner(x, p);
    }
    case "call": {
      const fn = FUNCS[node.name].fn;
      const args = node.args.map(compileNode);
      return (x, p) => fn(...args.map((a) => a(x, p)));
    }
    case "bin": {
      const a = compileNode(node.a);
      const b = compileNode(node.b);
      switch (node.op) {
        case "+":
          return (x, p) => a(x, p) + b(x, p);
        case "-":
          return (x, p) => a(x, p) - b(x, p);
        case "*":
          return (x, p) => a(x, p) * b(x, p);
        case "/":
          return (x, p) => a(x, p) / b(x, p);
        case "^":
          return (x, p) => Math.pow(a(x, p), b(x, p));
        default:
          throw new Error(`不支持的运算符 "${node.op}"`);
      }
    }
  }
}

/** Compile one expression against the declared parameter names. */
export function compileExpr(src: string, paramNames: readonly string[] = []): EvalFn {
  const tokens = tokenize(src);
  const node = new Parser(tokens, new Set(paramNames)).parse();
  return compileNode(node);
}
