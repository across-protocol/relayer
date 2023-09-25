import glob from 'glob';

if (!process.env.CI_TOTAL) {
    console.error('No environment variable CI_TOTAL defined');
    process.exit(1);
}

if (!process.env.CI_INDEX) {
    console.error('No environment variable CI_INDEX defined');
    process.exit(1);
}

function splitChunks(items: string[], total: number): string[][] {
    let chunks: string[][] = [];

    let currentChunk = 0;
    for (let currentItem = 0; currentItem < items.length; currentItem++) {
        if (!chunks[currentChunk]) {
            chunks[currentChunk] = [];
        }

        chunks[currentChunk].push(items[currentItem]);

        currentChunk++;
        if (currentChunk >= total) {
            currentChunk = 0;
        }
    }

    return chunks;
}

const files: string[] = glob.sync('test/**/*.ts');
const chunks: string[][] = splitChunks(files, parseInt(process.env.CI_TOTAL));

if (chunks[parseInt(process.env.CI_INDEX)]) {
    for (const file of chunks[parseInt(process.env.CI_INDEX)]) {
        process.stdout.write(file + "\n");
    }
}
