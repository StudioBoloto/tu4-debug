(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.TU4 = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const ACTIONS = new Set(["<", ">", "=", "#"]);

  function normalizeState(value) {
    return /^\d+$/.test(value) ? String(Number.parseInt(value, 10)) : value;
  }

  function printable(symbol) {
    return symbol === " " ? "␠" : symbol;
  }

  class CompileError extends Error {
    constructor(message, offset, line, column, extra) {
      super(message);
      this.name = "CompileError";
      this.offset = offset;
      this.line = line;
      this.column = column;
      Object.assign(this, extra || {});
    }
  }

  function locate(text, offset) {
    const before = text.slice(0, offset).split("\n");
    return { line: before.length, column: before[before.length - 1].length + 1 };
  }

  function compile(source, initialState) {
    const text = String(source || "").replace(/\r\n?/g, "\n");
    const commands = [];
    const byKey = new Map();
    let offset = 0;

    while (offset < text.length) {
      const rest = text.slice(offset);
      const whitespace = /^\s+/.exec(rest);
      if (whitespace) {
        offset += whitespace[0].length;
        continue;
      }

      const comment = /^(#|\/\/)[^\n]*(?:\n|$)/.exec(rest);
      if (comment) {
        offset += comment[0].length;
        continue;
      }

      const match = /^([^\s]+),(.),(.),([^\s]+)/.exec(rest);
      if (!match) {
        const at = locate(text, offset);
        throw new CompileError("Не удалось разобрать команду", offset, at.line, at.column);
      }

      const at = locate(text, offset);
      const command = {
        state: normalizeState(match[1]),
        read: match[2],
        action: match[3],
        next: normalizeState(match[4]),
        source: match[0],
        offset,
        line: at.line,
        column: at.column,
        index: commands.length,
      };
      const key = `${command.state}\u0000${command.read}`;
      if (byKey.has(key)) {
        const original = byKey.get(key);
        throw new CompileError(
          `Команда для состояния «${command.state}» и символа «${printable(command.read)}» уже есть в строке ${original.line}`,
          offset,
          at.line,
          at.column,
          { command, original }
        );
      }
      commands.push(command);
      byKey.set(key, command);
      offset += match[0].length;
    }

    if (!commands.length) {
      throw new CompileError("Программа пуста", 0, 1, 1);
    }

    const q0 = normalizeState(initialState == null ? "0" : String(initialState));
    const states = new Set(commands.map((command) => command.state));
    if (!states.has(q0)) {
      throw new CompileError(`Нет команд для начального состояния «${q0}»`, 0, 1, 1);
    }
    for (const command of commands) {
      if (!states.has(command.next)) {
        throw new CompileError(
          `Состояние назначения «${command.next}» не определено`,
          command.offset,
          command.line,
          command.column,
          { command }
        );
      }
    }

    return { source: text, commands, byKey, initialState: q0 };
  }

  class Machine {
    constructor(program, tape, options) {
      this.program = program;
      this.initialTape = String(tape || "").replace(/\s*$/, "");
      this.cells = new Map();
      Array.from(this.initialTape).forEach((symbol, index) => {
        if (symbol !== " ") this.cells.set(index, symbol);
      });
      this.state = program.initialState;
      this.head = this.initialTape.length;
      this.steps = 0;
      this.halted = false;
      this.error = null;
      this.history = [];
      this.historyLimit = Math.max(1, (options && options.historyLimit) || 50000);
      this.maxVisited = this.head;
      this.lastCommand = null;
    }

    read(position) {
      return this.cells.get(position == null ? this.head : position) || " ";
    }

    command() {
      return this.program.byKey.get(`${this.state}\u0000${this.read()}`) || null;
    }

    step() {
      if (this.halted) return { ok: false, halted: true, error: this.error };
      const command = this.command();
      if (!command) {
        this.history.push({
          state: this.state, head: this.head, steps: this.steps, halted: false, error: null,
          maxVisited: this.maxVisited, lastCommand: this.lastCommand,
          changedPosition: null, previousSymbol: null,
        });
        if (this.history.length > this.historyLimit) this.history.shift();
        this.error = `Нет команды для состояния «${this.state}» и символа «${printable(this.read())}»`;
        this.halted = true;
        return { ok: false, halted: true, error: this.error };
      }

      const before = {
        state: this.state,
        head: this.head,
        steps: this.steps,
        halted: this.halted,
        error: this.error,
        maxVisited: this.maxVisited,
        lastCommand: this.lastCommand,
        changedPosition: null,
        previousSymbol: null,
      };

      if (command.action === "<") {
        if (this.head === 0) {
          this.history.push(before);
          if (this.history.length > this.historyLimit) this.history.shift();
          this.error = "Головка вышла за левую границу ленты";
          this.halted = true;
          return { ok: false, halted: true, error: this.error, command };
        }
        this.head -= 1;
      } else if (command.action === ">") {
        this.head += 1;
      } else if (command.action !== "=" && command.action !== "#") {
        before.changedPosition = this.head;
        before.previousSymbol = this.read();
        if (command.action === " ") this.cells.delete(this.head);
        else this.cells.set(this.head, command.action);
      }

      this.state = command.next;
      this.steps += 1;
      this.lastCommand = command;
      this.maxVisited = Math.max(this.maxVisited, this.head);
      if (command.action === "#" || (command.read === command.action && command.state === command.next)) {
        this.halted = true;
      }
      this.history.push(before);
      if (this.history.length > this.historyLimit) this.history.shift();
      return { ok: true, halted: this.halted, command };
    }

    back() {
      const before = this.history.pop();
      if (!before) return false;
      if (before.changedPosition != null) {
        if (before.previousSymbol === " ") this.cells.delete(before.changedPosition);
        else this.cells.set(before.changedPosition, before.previousSymbol);
      }
      this.state = before.state;
      this.head = before.head;
      this.steps = before.steps;
      this.halted = before.halted;
      this.error = before.error;
      this.maxVisited = before.maxVisited;
      this.lastCommand = before.lastCommand;
      return true;
    }

    exportTape() {
      const lastCell = Math.max(this.maxVisited, ...this.cells.keys(), 0);
      let result = "";
      for (let i = 0; i <= lastCell; i += 1) result += this.read(i);
      return result;
    }
  }

  return { ACTIONS, CompileError, Machine, compile, normalizeState, printable };
});
