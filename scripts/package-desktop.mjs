import { packager } from "@electron/packager";
const paths = await packager({
  dir: ".",
  out: "release",
  platform: "darwin",
  arch: process.arch,
  name: "JobAgent",
  executableName: "JobAgent",
  appBundleId: "dev.jobagent.desktop",
  appVersion: "0.2.0",
  overwrite: true,
  asar: false,
  prune: true,
  extraResource: [".desktop-runtime"],
  ignore: [
    /^\/release($|\/)/,
    /^\/\.(git|github|idea)($|\/)/,
    /^\/\.jobagent[^/]*(\/|$)/,
    /^\/\.desktop-runtime($|\/)/,
    /^\/(tests|test-results|fixtures|desktop|scripts|docs|outputs)(\/|$)/,
    /^\/node_modules\/\.cache/,
    /^\/dist\/(tests|fixtures)(\/|$)/,
  ],
  darwinDarkModeSupport: false,
});
console.log(paths.join("\n"));
