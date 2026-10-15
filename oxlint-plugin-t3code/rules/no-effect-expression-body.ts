import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, unwrapExpression } from "../utils.ts";

const EFFECT_HOOKS = new Set(["useEffect", "useLayoutEffect", "useInsertionEffect"]);

// DOM methods whose result is never a cleanup function. Chromium's scroll
// methods now return promises, so `() => el?.scrollIntoView()` hands React a
// promise as the cleanup.
const NON_CLEANUP_METHODS = new Set([
  "scrollIntoView",
  "scrollTo",
  "scrollBy",
  "scroll",
  "focus",
  "blur",
  "click",
  "select",
  "play",
  "pause",
  "requestFullscreen",
  "exitFullscreen",
  "showModal",
  "requestPointerLock",
]);

// Expression bodies whose value is never a cleanup function.
const NON_CLEANUP_BODY_TYPES = new Set([
  "AssignmentExpression",
  "UpdateExpression",
  "AwaitExpression",
  "NewExpression",
  "Literal",
  "TemplateLiteral",
  "ObjectExpression",
  "ArrayExpression",
]);

/** The called name of `name(…)` or `object.name(…)`. */
const calleeName = (callee: unknown): Option.Option<string> =>
  Option.flatMap(unwrapExpression(callee), (expression) => {
    if (expression.type === "Identifier") return Option.some(expression.name);
    if (expression.type === "MemberExpression" && !expression.computed) {
      return getPropertyName(expression.property);
    }
    return Option.none();
  });

const leaksNonCleanup = (body: unknown): boolean =>
  Option.match(unwrapExpression(body), {
    onNone: () => false,
    onSome: (expression) => {
      if (NON_CLEANUP_BODY_TYPES.has(expression.type)) return true;
      if (expression.type !== "CallExpression") return false;
      const name = calleeName(expression.callee);
      return Option.isSome(name) && NON_CLEANUP_METHODS.has(name.value);
    },
  });

/**
 * React treats whatever an effect callback returns as its cleanup and calls it
 * on unmount, so an expression-bodied arrow leaks the expression's value there
 * and a non-function crashes with "destroy is not a function". Calls that may
 * return an unsubscribe function, like `() => store.subscribe(fn)`, are the
 * intended use and stay allowed.
 */
export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow effect callbacks whose expression body returns a non-function; React calls it as the cleanup.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const hook = calleeName(node.callee);
        if (Option.isNone(hook) || !EFFECT_HOOKS.has(hook.value)) return;
        const callback = node.arguments[0];
        if (callback?.type !== "ArrowFunctionExpression") return;
        if (callback.body.type === "BlockStatement") return;
        if (!leaksNonCleanup(callback.body)) return;

        context.report({
          node: callback,
          message: `Wrap the ${hook.value} callback body in braces. Its value becomes the effect cleanup, which React calls on unmount ("destroy is not a function").`,
        });
      },
    };
  },
});
