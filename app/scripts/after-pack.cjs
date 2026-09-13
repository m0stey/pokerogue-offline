// electron-builder afterPack hook: sets the Windows file description of PokeRogue.exe.
//
// `signAndEditExecutable: false` (see electron-builder.yml) skips electron-builder's own exe editing,
// so without this the program reports itself as "Electron" in Task Manager and file properties.
// rcedit ships with electron-winstaller, a dependency electron-builder already installs.

const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const exe = join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const rcedit = join(__dirname, "..", "node_modules", "electron-winstaller", "vendor", "rcedit.exe");
  if (!existsSync(exe) || !existsSync(rcedit)) {
    throw new Error(`afterPack: missing ${existsSync(exe) ? rcedit : exe}`);
  }
  const version = context.packager.appInfo.version;
  // electron-builder converts build/icon.png to this .ico before packing.
  const icon = join(context.outDir, ".icon-ico", "icon.ico");
  execFileSync(rcedit, [
    exe,
    "--set-version-string", "FileDescription", "FranziRogue",
    "--set-version-string", "ProductName", "FranziRogue",
    "--set-version-string", "CompanyName", "",
    "--set-version-string", "LegalCopyright", "",
    "--set-file-version", version,
    "--set-product-version", version,
    ...(existsSync(icon) ? ["--set-icon", icon] : []),
  ]);
};
