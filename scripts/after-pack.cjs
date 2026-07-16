const { rm } = require("node:fs/promises");
const { join } = require("node:path");

const OPTIONAL_GPU_FILES = [
  "dxcompiler.dll",
  "dxil.dll",
  "vk_swiftshader.dll",
];

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  await Promise.all(
    OPTIONAL_GPU_FILES.map((name) =>
      rm(join(context.appOutDir, name), { force: true }),
    ),
  );
};
