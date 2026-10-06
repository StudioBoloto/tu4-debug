const test = require("node:test");
const assert = require("node:assert/strict");
const { compile, CompileError, Machine } = require("../core.js");

test("разбирает несколько команд в строке и комментарии jstu4", () => {
  const program = compile("0, ,<,scan  scan,0,1,done // рядом\ndone,0,#,done\ndone,1,#,done");
  assert.equal(program.commands.length, 4);
  assert.equal(program.commands[1].line, 1);
  assert.equal(program.commands[2].line, 2);
});

test("нормализует числовые состояния как jstu4", () => {
  const program = compile("00, ,#,01 01, ,#,01");
  assert.equal(program.commands[0].state, "0");
  assert.equal(program.commands[0].next, "1");
});

test("отвергает неоднозначные команды", () => {
  assert.throws(() => compile("0, ,>,0 0, ,<,0"), (error) => {
    assert.ok(error instanceof CompileError);
    assert.match(error.message, /уже есть/);
    return true;
  });
});

test("головка начинает с первого пробела справа", () => {
  const program = compile("0, ,#,0");
  const machine = new Machine(program, "1011");
  assert.equal(machine.head, 4);
  assert.equal(machine.read(), " ");
});

test("шаг назад отменяет запись, состояние и счетчик", () => {
  const program = compile("0, ,1,next next,1,#,next");
  const machine = new Machine(program, "");
  machine.step();
  assert.equal(machine.read(0), "1");
  assert.equal(machine.state, "next");
  assert.equal(machine.steps, 1);
  assert.equal(machine.back(), true);
  assert.equal(machine.read(0), " ");
  assert.equal(machine.state, "0");
  assert.equal(machine.steps, 0);
});

test("после ошибки можно вернуться на шаг назад", () => {
  const program = compile("0, ,>,0");
  const machine = new Machine(program, "");
  machine.cells.set(0, "x");
  const result = machine.step();
  assert.equal(result.ok, false);
  assert.equal(machine.halted, true);
  assert.equal(machine.back(), true);
  assert.equal(machine.halted, false);
  assert.equal(machine.error, null);
});

test("самопереход без изменения считается остановкой как в jstu4", () => {
  const program = compile("0, , ,0");
  const machine = new Machine(program, "");
  machine.step();
  assert.equal(machine.halted, true);
});
