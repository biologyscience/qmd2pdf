import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ExtensionConfigPaths {
  quartoYaml: string;
  luaFilter: string;
}

export async function syncProjectConfigFiles(
  projectDirectory: string,
  isolatedDirectory: string,
  extensionConfig: ExtensionConfigPaths,
): Promise<boolean> {
  let changed = false;
  const yamlFiles = [
    { source: path.join(projectDirectory, "_quarto.yaml"), destination: path.join(isolatedDirectory, "_quarto.yaml") },
    { source: path.join(projectDirectory, "_quarto.yml"), destination: path.join(isolatedDirectory, "_quarto.yml") },
  ];
  const projectYamlExists = await Promise.all(yamlFiles.map((file) => isFile(file.source)));
  const hasProjectYaml = projectYamlExists.some(Boolean);
  for (const file of yamlFiles) {
    if (hasProjectYaml && await isFile(file.source)) {
      changed = (await copyIfChanged(file.source, file.destination)) || changed;
    } else if (hasProjectYaml || file.destination !== yamlFiles[0].destination) {
      changed = (await removeIfPresent(file.destination)) || changed;
    }
  }
  if (!hasProjectYaml) {
    changed = (await copyIfChanged(extensionConfig.quartoYaml, yamlFiles[0].destination)) || changed;
  }

  const sourceLuaFilter = path.join(projectDirectory, "filter.lua");
  const isolatedLuaFilter = path.join(isolatedDirectory, "filter.lua");
  if (await isFile(sourceLuaFilter)) {
    changed = (await copyIfChanged(sourceLuaFilter, isolatedLuaFilter)) || changed;
  } else {
    changed = (await copyIfChanged(extensionConfig.luaFilter, isolatedLuaFilter)) || changed;
  }
  return changed;
}

async function copyIfChanged(source: string, destination: string): Promise<boolean> {
  if (await isFile(destination)) {
    const [sourceContents, destinationContents] = await Promise.all([
      fs.readFile(source),
      fs.readFile(destination),
    ]);
    if (sourceContents.equals(destinationContents)) {
      return false;
    }
  }
  await fs.copyFile(source, destination);
  return true;
}

async function removeIfPresent(filePath: string): Promise<boolean> {
  if (!(await isFile(filePath))) {
    return false;
  }
  await fs.rm(filePath);
  return true;
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
