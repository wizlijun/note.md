/** 浏览器式前进/后退栈。current() 恒有值(初始项)。 */
export class NavHistory<T> {
  private stack: T[]
  private idx: number
  constructor(initial: T) { this.stack = [initial]; this.idx = 0 }
  current(): T { return this.stack[this.idx] }
  canBack(): boolean { return this.idx > 0 }
  canForward(): boolean { return this.idx < this.stack.length - 1 }
  push(view: T): void {
    this.stack = this.stack.slice(0, this.idx + 1)
    this.stack.push(view)
    this.idx = this.stack.length - 1
  }
  back(): T { if (this.canBack()) this.idx--; return this.current() }
  forward(): T { if (this.canForward()) this.idx++; return this.current() }
}
