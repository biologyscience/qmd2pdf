const { spawn } = require('child_process');
const { existsSync, watchFile, copyFile } = require('fs');

function build(filepath)
{
    const child = spawn('quarto', ['render', filepath]);

    child.stdout.on('data', data => console.log(data.toString()));
    child.stderr.on('data', data => console.log(data.toString()));
    child.on('close', () => console.log(new Date().toLocaleString()));
}

if (!process.argv[2]) return;

const file = process.argv[2].endsWith('.qmd') ? process.argv[2] : `${process.argv[2]}/file.qmd`;

if (!existsSync(file)) return;

watchFile(file, () =>
{
    if (!existsSync(file)) return process.exit();

    const tempFile = file.replace('.qmd', '.temp.qmd');

    copyFile(file, tempFile, () => build(tempFile));
});