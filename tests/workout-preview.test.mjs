import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const require = createRequire(import.meta.url);
function load(path, mocks = {}) {
  const code = ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const loaded = { exports: {} };
  new vm.Script(`(function(require,module,exports){${code}\n})`).runInThisContext()((name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports);
  return loaded.exports;
}
const step = (id, name, videoUrl) => ({ id, position: id === "one" ? 0 : 1, exerciseName: name, durationSeconds: 20, restSeconds: 5, offHand: false, notes: null, videoUrl });
function findAll(tree, predicate, found = []) {
  if (!tree || typeof tree !== "object") return found;
  if (predicate(tree)) found.push(tree);
  const children = tree.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) findAll(child, predicate, found);
  return found;
}
function previewHarness() {
  const values = [], refs = [], effects = [], focuses = []; let cursor = 0;
  const fakeReact = {
    useState: (value) => { const i = cursor++; if (!(i in values)) values[i] = value; return [values[i], (next) => { values[i] = typeof next === "function" ? next(values[i]) : next; }]; },
    useRef: (value) => { const i = cursor++; if (!refs[i]) refs[i] = { current: value }; return refs[i]; },
    useEffect: (fn) => effects.push(fn),
  };
  const video = () => null;
  const preview = load("src/components/workout/workout-preview.tsx", { react: fakeReact, "./exercise-video": { default: video, safeVideoUrl: (url) => typeof url === "string" && url.startsWith("https://") ? url : null } });
  const mountRefs = (tree) => findAll(tree, (node) => typeof node.props?.ref === "function").forEach((node) => node.props.ref({ focus: () => focuses.push(node.props["aria-label"] ?? "close") }));
  return { video, focuses, render: (steps) => { cursor = 0; effects.length = 0; const tree = preview.default({ steps }); mountRefs(tree); return tree; }, commit: () => effects.splice(0).forEach((effect) => effect()) };
}
test("preview exposes only safe row demos and replaces the selected demo without workout actions", () => {
  const h = previewHarness(); const steps = [step("one", "Frozen Cradle", "https://example.com/one.mp4"), step("two", "Frozen Switch", "https://example.com/two.mp4"), step("three", "No Demo", null), step("four", "Unsafe", "javascript:bad")];
  let tree = h.render(steps);
  const views = findAll(tree, (node) => node.type === "button" && String(node.props["aria-label"] ?? "").startsWith("View demo"));
  assert.deepEqual(views.map((node) => node.props["aria-label"]), ["View demo for Frozen Cradle", "View demo for Frozen Switch"]);
  views[0].props.onClick(); tree = h.render(steps);
  let demos = findAll(tree, (node) => node.type === h.video); assert.equal(demos.length, 1); assert.equal(demos[0].props.url, "https://example.com/one.mp4");
  findAll(tree, (node) => node.type === "button" && node.props["aria-label"] === "View demo for Frozen Switch")[0].props.onClick(); tree = h.render(steps);
  demos = findAll(tree, (node) => node.type === h.video); assert.equal(demos.length, 1); assert.equal(demos[0].props.url, "https://example.com/two.mp4");
  findAll(tree, (node) => node.type === "button" && node.props["aria-label"] === "Close demo for Frozen Switch")[0].props.onClick(); tree = h.render(steps);
  assert.equal(findAll(tree, (node) => node.type === h.video).length, 0);
});
test("exercise video renders a factual fallback after media error", () => {
  const values = []; let cursor = 0;
  const fakeReact = { useRef: () => ({ current: null }), useState: (value) => { const i = cursor++; if (!(i in values)) values[i] = value; return [values[i], (next) => { values[i] = next; }]; }, useEffect: () => {} };
  const video = load("src/components/workout/exercise-video.tsx", { react: fakeReact });
  const render = () => { cursor = 0; return video.default({ url: "https://example.com/demo.mp4" }); };
  let tree = render(); findAll(tree, (node) => node.type === "video")[0].props.onError(); tree = render();
  assert.equal(tree.props.children, "Demo unavailable");
});
test("preview moves focus to the opened demo close control and restores its stable trigger", () => {
  const h = previewHarness(); const steps = [step("one", "Repeat", "https://example.com/one.mp4"), step("two", "Repeat", "https://example.com/two.mp4")];
  let tree = h.render(steps); const views = findAll(tree, (node) => node.type === "button" && String(node.props["aria-label"] ?? "").startsWith("View demo"));
  views[0].props.onClick(); tree = h.render(steps); h.commit(); assert.equal(h.focuses.at(-1), "Close demo for Repeat");
  findAll(tree, (node) => node.props?.["aria-label"] === "Close demo for Repeat")[0].props.onClick(); tree = h.render(steps); h.commit(); assert.equal(h.focuses.at(-1), "View demo for Repeat");
  findAll(tree, (node) => node.props?.["aria-label"] === "View demo for Repeat")[1].props.onClick(); tree = h.render(steps); h.commit(); assert.equal(h.focuses.at(-1), "Close demo for Repeat");
});
