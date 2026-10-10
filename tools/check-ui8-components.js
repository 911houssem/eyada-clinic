const fs = require("fs");
const vm = require("vm");
const { COMPONENTS } = require("./ui8-components.js");

// split on top-level function declarations
const parts = COMPONENTS.split(/(?=function ui8)/).filter((s) => s.trim());
const ctx = {
  module: { exports: {} }, exports: {}, window: {},
  confirm: () => true, console, fetch: () => {}, encodeURIComponent,
  Object, Number, String, Array, setTimeout, Math, JSON, Boolean, Promise, Error, isNaN, parseInt,
};
const prelude = `
var d = { useState: () => [0, () => {}], useEffect: () => {} };
var u = { jsx: (...a) => ({ a }), jsxs: (...a) => ({ a }) };
var p = { default: () => (...a) => ({ a }) };
var ui8IconClock = 1, ui8IconShield = 1, ui8IconTag = 1;
function xM(){ return { user: null, logout: () => {} }; }
`;
const base = {
  module: { exports: 0 }, exports: {}, window: {},
  confirm: () => true, console, fetch: () => {}, encodeURIComponent,
  Object, Number, String, Array, setTimeout, Math, JSON, Boolean, Promise, Error, isNaN, parseInt,
};
for (const part of parts) {
  const name = (part.match(/function (ui8\w+)/) || [])[1];
  const box = vm.createContext(Object.assign({}, base));
  try {
    new vm.Script(prelude + part + "\nmodule.exports=1;", { filename: name }).runInContext(box);
    console.log("OK      " + name + "  (" + part.length + " chars)");
  } catch (e) {
    console.log("FAIL    " + name + " -> " + e.message);
  }
}