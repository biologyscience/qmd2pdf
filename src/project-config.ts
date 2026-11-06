import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ExtensionConfigPaths {
  quartoYaml: string;
  luaFilter: string;
}

export async function ensureProjectConfigFallbacks(
  projectDirectory: string,
  extensionConfig: ExtensionConfigPaths,
): Promise<void> {
  const projectYamlPaths = [
    path.join(projectDirectory, "_quarto.yaml"),
    path.join(projectDirectory, "_quarto.yml"),
  ];
  const yamlExists = await Promise.all(projectYamlPaths.map(isFile));
  if (!yamlExists.some(Boolean)) {
    await fs.copyFile(extensionConfig.quartoYaml, projectYamlPaths[0]);
  }

  const projectLuaFilter = path.join(projectDirectory, "filter.lua");
  if (!(await isFile(projectLuaFilter))) {
    await fs.copyFile(extensionConfig.luaFilter, projectLuaFilter);
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
