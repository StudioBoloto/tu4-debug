(function () {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const els = {
    program: $("#program"), tapeInput: $("#tape-input"), tape: $("#tape"),
    gutter: $("#gutter"), highlights: $("#line-highlights"), syntax: $("#syntax-status"),
    message: $("#message"), start: $("#start"), quick: $("#quick"), pause: $("#pause"),
    step: $("#step"), back: $("#back"), speed: $("#speed"),
    runToState: $("#run-to-state"), runTo: $("#run-to"),
    watchState: $("#watch-state"), watchStep: $("#watch-step"),
    watchHead: $("#watch-head"), watchSymbol: $("#watch-symbol"), watchCommand: $("#watch-command"),
    statCommands: $("#stat-commands"), statInput: $("#stat-input"),
    statCells: $("#stat-cells"), statSteps: $("#stat-steps"),
    saveState: $("#save-state"), fileOpen: $("#file-open"), fileSave: $("#file-save"),
    tapeLeft: $("#tape-left"), tapeCenter: $("#tape-center"), tapeRight: $("#tape-right"),
    theme: $("#theme"), help: $("#help"), helpDialog: $("#help-dialog"),
  };

  const DEFAULT_PROGRAM = `# Инвертирует 0 и 1, затем возвращает головку вправо
0, ,<,scan
scan,0,1,left   scan,1,0,left   scan, ,>,finish
left,0,<,scan   left,1,<,scan
finish,0,>,finish   finish,1,>,finish   finish, ,#,finish`;
  const STORAGE = "tu4-debug:v1";
  const MAX_AUTO_STEPS = 1000000;
  let compiled = null;
  let machine = null;
  let timer = null;
  let tapeOffset = null;
  let lastChangedPosition = null;
  let breakLines = new Set();
  let runToTarget = null;
  let skipBreakpointOnce = false;
  let pausedOnBreakpoint = false;
  let saveTimer = null;

  function setMessage(text, kind) {
    els.message.textContent = text;
    els.message.className = `message${kind ? ` ${kind}` : ""}`;
  }

  function saveSoon() {
    els.saveState.textContent = "Сохраняю…";
    els.saveState.classList.add("saving");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE, JSON.stringify({
          program: els.program.value,
          tape: els.tapeInput.value,
          gutterBreaks: [...breakLines],
          speed: els.speed.value,
          theme: document.documentElement.dataset.theme || "dark",
        }));
        els.saveState.textContent = "Сохранено";
        els.saveState.classList.remove("saving");
      } catch (_) {
        els.saveState.textContent = "Не удалось сохранить";
      }
    }, 180);
  }

  function loadSaved() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORAGE) || "{}"); } catch (_) { /* ignore */ }
    els.program.value = typeof saved.program === "string" ? saved.program : DEFAULT_PROGRAM;
    els.tapeInput.value = typeof saved.tape === "string" ? saved.tape : " 1011";
    breakLines = new Set(Array.isArray(saved.gutterBreaks) ? saved.gutterBreaks : []);
    els.speed.value = saved.speed || "120";
    document.documentElement.dataset.theme = saved.theme === "light" ? "light" : "dark";
    els.theme.textContent = saved.theme === "light" ? "☀" : "☾";
  }

  function validate(options) {
    try {
      const next = TU4.compile(els.program.value, "0");
      compiled = next;
      els.syntax.textContent = `${next.commands.length} команд · синтаксис в порядке`;
      els.syntax.className = "status ok";
      if (machine && (!options || options.keepMachine !== false)) machine.program = next;
      if (els.message.classList.contains("error")) setMessage("Синтаксис исправлен. Можно продолжать.");
      renderEditor();
      updateAll();
      return true;
    } catch (error) {
      compiled = null;
      els.syntax.textContent = error instanceof TU4.CompileError
        ? `Строка ${error.line}, столбец ${error.column}: ${error.message}`
        : String(error.message || error);
      els.syntax.className = "status error";
      renderEditor(error.line);
      if (timer) stopTimer();
      setMessage("Исправьте ошибку в программе", "error");
      return false;
    }
  }

  function newMachine() {
    if (!compiled && !validate({ keepMachine: false })) return false;
    machine = new TU4.Machine(compiled, els.tapeInput.value, { historyLimit: 50000 });
    lastChangedPosition = null;
    tapeOffset = null;
    setMessage("Машина готова");
    updateAll();
    return true;
  }

  function ensureMachine() {
    if (!compiled && !validate()) return false;
    return machine ? true : newMachine();
  }

  function reset() {
    stopTimer();
    machine = null;
    runToTarget = null;
    lastChangedPosition = null;
    tapeOffset = null;
    if (validate({ keepMachine: false })) setMessage("Сброшено к начальному слову");
    updateAll();
  }

  function stopTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    els.quick.innerHTML = "<span>»</span> До конца";
    els.pause.disabled = true;
  }

  function pause(text, kind) {
    stopTimer();
    if (text) setMessage(text, kind);
    updateAll();
  }

  function isBreakpoint(command) {
    if (!command) return false;
    return breakLines.has(command.line);
  }

  function performStep() {
    if (!ensureMachine()) return false;
    const beforeHead = machine.head;
    const command = machine.command();
    const result = machine.step();
    lastChangedPosition = command && !TU4.ACTIONS.has(command.action) ? beforeHead : null;
    if (!result.ok) {
      runToTarget = null;
      pause(result.error || "Выполнение остановлено", "error");
      return false;
    }
    if (machine.halted) {
      runToTarget = null;
      pause(`Готово за ${machine.steps} ${plural(machine.steps, "шаг", "шага", "шагов")}`);
      return false;
    }
    return true;
  }

  function manualStep() {
    stopTimer();
    runToTarget = null;
    pausedOnBreakpoint = false;
    if (machine && machine.halted) {
      setMessage("Выполнение завершено. «Старт» начнёт заново.", "warning");
      return;
    }
    if (performStep()) setMessage("Выполнен один шаг");
    updateAll();
  }

  function stepBack() {
    stopTimer();
    runToTarget = null;
    pausedOnBreakpoint = false;
    if (!ensureMachine()) return;
    if (machine.back()) {
      lastChangedPosition = null;
      setMessage("Вернулись на один шаг");
    } else {
      setMessage("Это самое начало", "warning");
    }
    updateAll();
  }

  function start() {
    stopTimer();
    machine = null;
    runToTarget = null;
    pausedOnBreakpoint = false;
    lastChangedPosition = null;
    tapeOffset = null;
    if (!newMachine()) return;
    if (performStep()) setMessage("Первый шаг выполнен");
    updateAll();
  }

  function run() {
    if (machine && machine.halted) machine = null;
    if (!ensureMachine()) return;
    if (timer) return;
    skipBreakpointOnce = pausedOnBreakpoint;
    pausedOnBreakpoint = false;
    els.quick.innerHTML = "<span>»</span> Выполняется";
    els.pause.disabled = false;
    scheduleBatch();
  }

  function scheduleBatch() {
    const delay = Number(els.speed.value);
    timer = setTimeout(() => {
      timer = null;
      const batchSize = delay === 0 ? 1000 : 1;
      for (let i = 0; i < batchSize; i += 1) {
        const command = machine.command();
        if (runToTarget != null && machine.state === runToTarget) {
          const target = runToTarget;
          runToTarget = null;
          pause(`Дошли до состояния «${target}»`);
          return;
        }
        if (!skipBreakpointOnce && isBreakpoint(command)) {
          pausedOnBreakpoint = true;
          pause(`Брейкпоинт перед строкой ${command.line}, состояние «${machine.state}»`);
          return;
        }
        skipBreakpointOnce = false;
        if (!performStep()) return;
        if (machine.steps >= MAX_AUTO_STEPS) {
          pause(`Защитная остановка после ${MAX_AUTO_STEPS.toLocaleString("ru-RU")} шагов`, "warning");
          return;
        }
      }
      updateAll();
      scheduleBatch();
    }, delay === 0 ? 0 : delay);
  }

  function plural(number, one, few, many) {
    const n10 = number % 10;
    const n100 = number % 100;
    if (n10 === 1 && n100 !== 11) return one;
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
    return many;
  }

  function runTo() {
    const target = TU4.normalizeState(els.runToState.value.trim());
    if (!target) {
      setMessage("Укажите состояние, до которого нужно дойти", "warning");
      els.runToState.focus();
      return;
    }
    if (machine && machine.halted) machine = null;
    if (!ensureMachine()) return;
    runToTarget = target;
    run();
  }

  function visibleTape() {
    const width = window.innerWidth < 620 ? 13 : window.innerWidth < 1050 ? 17 : 25;
    const head = machine ? machine.head : els.tapeInput.value.replace(/\s*$/, "").length;
    const center = tapeOffset == null ? head : tapeOffset;
    const start = Math.max(0, center - Math.floor(width / 2));
    return { start, end: start + width - 1, head };
  }

  function readInitial(position) {
    return els.tapeInput.value.replace(/\s*$/, "").charAt(position) || " ";
  }

  function renderTape() {
    const { start, end, head } = visibleTape();
    const fragment = document.createDocumentFragment();
    for (let index = start; index <= end; index += 1) {
      const symbol = machine ? machine.read(index) : readInitial(index);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `cell${symbol === " " ? " blank" : ""}${index === head ? " head" : ""}${index === lastChangedPosition ? " changed" : ""}`;
      cell.dataset.index = String(index);
      cell.title = `Ячейка ${index}: ${TU4.printable(symbol)}`;
      cell.innerHTML = `<span class="cell-index">${index}</span><span>${escapeHtml(TU4.printable(symbol))}</span>${index === head ? '<span class="cell-head">▲</span>' : ""}`;
      fragment.appendChild(cell);
    }
    els.tape.replaceChildren(fragment);
  }

  function renderEditor(errorLine) {
    const lines = els.program.value.split("\n");
    const activeLine = machine && machine.command() ? machine.command().line : null;
    const executed = new Set(machine ? machine.history.map((item) => item.lastCommand && item.lastCommand.line).filter(Boolean) : []);
    els.gutter.innerHTML = lines.map((_, index) => {
      const line = index + 1;
      return `<div class="gutter-line${breakLines.has(line) ? " breakpoint" : ""}${activeLine === line ? " active" : ""}" data-line="${line}">${line}</div>`;
    }).join("");
    els.highlights.innerHTML = lines.map((_, index) => {
      const line = index + 1;
      const classes = ["line-highlight"];
      if (activeLine === line || errorLine === line) classes.push("active");
      else if (executed.has(line)) classes.push("executed");
      return `<div class="${classes.join(" ")}"></div>`;
    }).join("");
    syncEditorScroll();
  }

  function syncEditorScroll() {
    const y = `translateY(${-els.program.scrollTop}px)`;
    els.gutter.style.transform = y;
    els.highlights.style.transform = y;
  }

  function updateAll() {
    const state = machine ? machine.state : "0";
    const head = machine ? machine.head : els.tapeInput.value.replace(/\s*$/, "").length;
    const symbol = machine ? machine.read() : readInitial(head);
    const command = machine ? machine.command() : (compiled && compiled.byKey.get(`0\u0000${symbol}`));
    els.watchState.textContent = state;
    els.watchStep.textContent = machine ? String(machine.steps) : "0";
    els.watchHead.textContent = String(head);
    els.watchSymbol.textContent = TU4.printable(symbol);
    els.watchCommand.textContent = command ? `${command.line} · ${command.source}` : "—";
    const inputLength = els.tapeInput.value.replace(/\s*$/, "").length;
    els.statCommands.textContent = compiled ? String(compiled.commands.length) : "—";
    els.statInput.textContent = String(inputLength);
    els.statCells.textContent = String(machine ? machine.maxVisited + 1 : inputLength + 1);
    els.statSteps.textContent = machine ? String(machine.steps) : "0";
    els.back.disabled = !machine || !machine.history.length;
    els.step.disabled = Boolean(timer) || !machine || machine.halted;
    els.quick.disabled = Boolean(timer);
    renderTape();
    renderEditor();
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function downloadProgram() {
    const blob = new Blob([els.program.value], { type: "text/plain;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "program.tu4";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }

  els.program.addEventListener("input", () => {
    validate();
    saveSoon();
  });
  els.program.addEventListener("scroll", syncEditorScroll);
  els.tapeInput.addEventListener("input", () => {
    stopTimer();
    machine = null;
    lastChangedPosition = null;
    tapeOffset = null;
    validate({ keepMachine: false });
    updateAll();
    saveSoon();
  });
  els.speed.addEventListener("change", saveSoon);
  els.gutter.addEventListener("click", (event) => {
    const line = Number(event.target.closest("[data-line]")?.dataset.line);
    if (!line) return;
    breakLines.has(line) ? breakLines.delete(line) : breakLines.add(line);
    renderEditor();
    saveSoon();
  });
  els.tape.addEventListener("click", (event) => {
    const index = Number(event.target.closest("[data-index]")?.dataset.index);
    if (!Number.isFinite(index) || !ensureMachine()) return;
    stopTimer();
    machine.head = index;
    machine.history = [];
    machine.halted = false;
    machine.error = null;
    pausedOnBreakpoint = false;
    tapeOffset = null;
    setMessage(`Головка переставлена в ячейку ${index}; история очищена`, "warning");
    updateAll();
  });
  els.start.addEventListener("click", start);
  els.quick.addEventListener("click", run);
  els.pause.addEventListener("click", () => pause("Пауза"));
  els.step.addEventListener("click", manualStep);
  els.back.addEventListener("click", stepBack);
  els.runTo.addEventListener("click", runTo);
  els.runToState.addEventListener("keydown", (event) => { if (event.key === "Enter") runTo(); });
  els.tapeLeft.addEventListener("click", () => { const view = visibleTape(); tapeOffset = Math.max(0, (tapeOffset ?? view.head) - 6); renderTape(); });
  els.tapeRight.addEventListener("click", () => { const view = visibleTape(); tapeOffset = (tapeOffset ?? view.head) + 6; renderTape(); });
  els.tapeCenter.addEventListener("click", () => { tapeOffset = null; renderTape(); });
  els.fileSave.addEventListener("click", downloadProgram);
  els.fileOpen.addEventListener("change", async () => {
    const file = els.fileOpen.files[0];
    if (!file) return;
    els.program.value = await file.text();
    reset();
    validate({ keepMachine: false });
    saveSoon();
    els.fileOpen.value = "";
  });
  els.theme.addEventListener("click", () => {
    const light = document.documentElement.dataset.theme !== "light";
    document.documentElement.dataset.theme = light ? "light" : "dark";
    els.theme.textContent = light ? "☀" : "☾";
    saveSoon();
  });
  els.help.addEventListener("click", () => els.helpDialog.showModal());
  window.addEventListener("resize", renderTape);
  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); start(); }
    if (event.key === "F5") { event.preventDefault(); run(); }
    if (event.key === "F10") { event.preventDefault(); event.shiftKey ? stepBack() : manualStep(); }
    if (event.key === "Escape" && timer) pause("Пауза");
  });

  loadSaved();
  validate({ keepMachine: false });
  updateAll();
})();
