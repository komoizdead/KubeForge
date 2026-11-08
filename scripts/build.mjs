import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scope = "@kubeforge";
const groups = ["sdk", "agents", "mcp"];
const tscBin = join(root, "node_modules", "typescript", "bin", "tsc");
const localModules = join(root, "node_modules", scope);

function loadPackage(dir) {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return undefined;
  return { dir, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) };
}

function readPackages() {
  const packages = [];

  for (const group of groups) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;

    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const pkg = loadPackage(join(groupDir, entry.name));
      if (pkg) packages.push(pkg);
    }
  }

  const testsPackage = loadPackage(join(root, "tests"));
  if (testsPackage) packages.push(testsPackage);

  return packages;
}

function sortByDependencies(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.manifest.name, pkg]));
  const state = new Map();
  const ordered = [];

  const visit = (pkg, chain) => {
    const name = pkg.manifest.name;
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      throw new Error(`Circular dependency: ${[...chain, name].join(" -> ")}`);
    }

    state.set(name, "visiting");

    for (const dependency of Object.keys(pkg.manifest.dependencies ?? {})) {
      if (!dependency.startsWith(`${scope}/`)) continue;
      const dependencyPackage = byName.get(dependency);
      if (!dependencyPackage) {
        throw new Error(`${name} depends on ${dependency}, which is not a workspace package`);
      }
      visit(dependencyPackage, [...chain, name]);
    }

    state.set(name, "done");
    ordered.push(pkg);
  };

  for (const pkg of packages) visit(pkg, []);
  return ordered;
}

function copyIntoNodeModules(pkg) {
  const target = join(localModules, pkg.manifest.name.slice(scope.length + 1));

  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(pkg.dir, "package.json"), join(target, "package.json"));
  cpSync(join(pkg.dir, "dist"), join(target, "dist"), { recursive: true });
}

function clean(packages) {
  for (const pkg of packages) {
    rmSync(join(pkg.dir, "dist"), { recursive: true, force: true });
  }
  rmSync(localModules, { recursive: true, force: true });
  process.stdout.write("Cleaned package output.\n");
}

function build(packages) {
  if (!existsSync(tscBin)) {
    throw new Error("TypeScript is not installed. Run `pnpm install` first.");
  }

  for (const pkg of packages) {
    process.stdout.write(`Building ${pkg.manifest.name}\n`);

    const result = spawnSync(process.execPath, [tscBin, "-p", "tsconfig.json"], {
      cwd: pkg.dir,
      stdio: "inherit",
    });

    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }

    if (pkg.manifest.main) copyIntoNodeModules(pkg);
  }
}

function test() {
  const result = spawnSync(process.execPath, ["--test", "dist/**/*.test.js"], {
    cwd: join(root, "tests"),
    stdio: "inherit",
  });

  process.exit(result.status ?? 0);
}

const packages = sortByDependencies(readPackages());
const args = new Set(process.argv.slice(2));

if (args.has("--clean")) {
  clean(packages);
} else {
  build(packages);
  if (args.has("--test")) test();
}
