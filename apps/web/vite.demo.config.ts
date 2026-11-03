import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
export default defineConfig({
 root:fileURLToPath(new URL('./demo',import.meta.url)),
 base:'./',
 build:{outDir:'../dist-demo',emptyOutDir:true},
 server:{host:'127.0.0.1'},
});
