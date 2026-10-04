import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);

function load(path, mocks = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`).runInThisContext()((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}

function findButton(tree) {
  if (!tree || typeof tree !== "object") return null;
  if (tree.type === "button") return tree;
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findButton(child);
    if (found) return found;
  }
  return null;
}

function textInTree(tree) {
  if (typeof tree === "string") return tree;
  if (!tree || typeof tree !== "object") return "";
  const children = tree.props?.children;
  return (Array.isArray(children) ? children : [children]).map(textInTree).join(" ");
}

function selectionHarness({ rpcError, ...props } = {}) {
  const values = [];
  let slot = 0;
  let refreshed = 0;
  const calls = [];
  const react = {
    useMemo: (create) => create(),
    useState: (initial) => {
      const index = slot++;
      if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
      return [values[index], (next) => { values[index] = typeof next === "function" ? next(values[index]) : next; }];
    },
  };
  const component = load("src/components/workout/challenge-selection.tsx", {
    react,
    "next/navigation": { useRouter: () => ({ refresh: () => { refreshed += 1; } }) },
    "@/lib/supabase/client": { createClient: () => ({ rpc: async (name, args) => { calls.push({ name, args }); return { error: rpcError ? { message: rpcError } : null }; } }) },
  });
  const render = () => { slot = 0; return component.default({ sessionId: "session-1", challengeAvailable: true, canSelectChallenge: true, selectionLocked: false, selectedVariant: "assigned", ...props }); };
  return { render, calls, refreshed: () => refreshed };
}

test("selection UI calls only the canonical self-selection RPC and refreshes after success", async () => {
  const h = selectionHarness();
  const button = findButton(h.render());
  assert.equal(button.props.children, "Level Up This TILT");
  await button.props.onClick();
  assert.deepEqual(h.calls, [{ name: "select_my_training_session_variant", args: { p_session_id: "session-1", p_variant: "challenge" } }]);
  assert.equal(h.refreshed(), 1);
});

test("selection failure leaves Assigned visible and reports a factual error", async () => {
  const h = selectionHarness({ rpcError: "Challenge selection is locked after workout start" });
  await findButton(h.render()).props.onClick();
  const rerendered = h.render();
  assert.match(textInTree(rerendered), /performed version cannot change/);
  assert.equal(h.refreshed(), 0);
});

test("selected and locked states have no Challenge switch", () => {
  const selected = selectionHarness({ selectedVariant: "challenge" }).render();
  assert.match(textInTree(selected), /Challenge selected/);
  assert.equal(findButton(selected), null);
  const locked = selectionHarness({ selectionLocked: true }).render();
  assert.match(textInTree(locked), /Assigned/);
  assert.equal(findButton(locked), null);
});

test("guardian and unavailable contexts do not expose selection controls", () => {
  assert.equal(selectionHarness({ canSelectChallenge: false }).render(), null);
  assert.equal(selectionHarness({ challengeAvailable: false }).render(), null);
});

test("dashboard history labels only Challenge-performed sessions", () => {
  const page = readFileSync(new URL("../src/app/page.tsx", import.meta.url), "utf8");
  assert.match(page, /recent && session\.performedVariant === "challenge"/);
  assert.match(page, />Challenge</);
});
