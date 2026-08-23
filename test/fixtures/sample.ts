// Fixture for complexity counting tests.
// Each function targets a specific construct so tests can assert exact CC.

// CC = 1 (no branches)
export function plain(): number {
  return 1;
}

// CC = 2 (one if)
export function withIf(x: number): number {
  if (x > 0) {
    return x;
  }
  return 0;
}

// CC = 3 (if + else-if chain -> two if statements)
export function withElseIf(x: number): string {
  if (x > 0) {
    return "pos";
  } else if (x < 0) {
    return "neg";
  }
  return "zero";
}

// CC = 3 (for + if)
export function withForAndIf(items: number[]): number {
  let sum = 0;
  for (const item of items) {
    if (item > 0) {
      sum += item;
    }
  }
  return sum;
}

// CC = 2 (while)
export function withWhile(n: number): number {
  let i = 0;
  while (i < n) {
    i++;
  }
  return i;
}

// CC = 2 (do-while)
export function withDoWhile(n: number): number {
  let i = 0;
  do {
    i++;
  } while (i < n);
  return i;
}

// CC = 2 (for-in)
export function withForIn(obj: Record<string, number>): number {
  let sum = 0;
  for (const key in obj) {
    sum += obj[key];
  }
  return sum;
}

// CC = 2 (catch)
export function withCatch(): number {
  try {
    return risky();
  } catch (e) {
    return -1;
  }
}

function risky(): number {
  throw new Error("boom");
}

// CC = 3 (switch with two cases; default not counted)
export function withSwitch(code: number): string {
  switch (code) {
    case 1:
      return "one";
    case 2:
      return "two";
    default:
      return "other";
  }
}

// CC = 2 (ternary)
export function withTernary(x: number): string {
  return x > 0 ? "pos" : "non-pos";
}

// CC = 3 (&& and || -> two short-circuit operators)
export function withLogicalOps(a: boolean, b: boolean): boolean {
  return a && b || !a;
}

// CC = 4 (?? + && + ?? -> three short-circuit operators)
export function withNullish(a: string | null, b: string | null): string {
  return (a ?? "") && (b ?? "");
}

// CC = 1 (arrow function assigned to const)
export const arrowPlain = (x: number): number => x + 1;

// CC = 2 (arrow with if)
export const arrowWithIf = (x: number): number => {
  if (x > 0) {
    return x * 2;
  }
  return x;
};

// Method complexity inside a class.
export class MyClass {
  // CC = 1
  plain(): number {
    return 1;
  }

  // CC = 2 (if)
  withIf(x: number): number {
    if (x > 0) {
      return x;
    }
    return 0;
  }

  // CC = 1 (constructor)
  constructor(private value: number) {}

  // CC = 2 (get accessor with ternary)
  get doubled(): number {
    return this.value > 0 ? this.value * 2 : 0;
  }

  // CC = 1
  set setValue(v: number) {
    this.value = v;
  }
}

// Nested function: outer CC = 2 (if), inner CC = 1 (not counted in outer)
export function withNested(x: number): number {
  if (x > 0) {
    const inner = (y: number): number => y + 1;
    return inner(x);
  }
  return 0;
}

// Never called -> coverage 0 in tests
export function neverCalled(): number {
  return 42;
}
