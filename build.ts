import esbuild from "esbuild";

esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    outfile: "dist/bundle.js",
    platform: "node",
    target: "es2020",
    sourcemap: true,
    minify: false
}).catch(() => process.exit(1));