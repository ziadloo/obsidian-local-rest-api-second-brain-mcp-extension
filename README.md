# Obsidian Local REST API Second Brain MCP Extension

This plugin is an extension (or "meta-plugin") for the [Obsidian Local REST API](https://github.com/coddingtonbear/obsidian-local-rest-api) plugin. It transforms your Obsidian vault into a powerful, AI-ready "Second Brain" by exposing a specialized [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server endpoint.

## Purpose

The primary goal of this extension is to provide Large Language Models (LLMs) with intelligent, semantically grounded access to your personal knowledge base. Instead of dumping your entire vault into an LLM's context window, this plugin uses a localized semantic search engine to find the most relevant notes.

When an LLM queries your wiki, the plugin performs:
1. **Semantic Search:** Uses local embedding models (e.g., `all-MiniLM-L6-v2`) to find the best entry points (root nodes) based on the meaning of the query.
2. **Graph Traversal (BFS):** Navigates through Obsidian's internal links (both outgoing links and backlinks) to gather contextual knowledge surrounding those entry points.

This ensures the LLM receives highly relevant, interconnected information while remaining extremely token-efficient.

## Comparison with the Parent Plugin

The parent plugin (**Obsidian Local REST API**) provides the foundational infrastructure:
* It sets up the secure (HTTPS) and non-encrypted (HTTP) local web servers.
* It handles authentication (API keys/Bearer tokens) and certificate management.
* It exposes basic endpoints for creating, reading, updating, and deleting raw files in your vault.

This **Second Brain MCP Extension** builds on top of that infrastructure:
* It does **not** manage its own web servers or authentication; it securely registers a new route (`/second-brain-mcp/`) using the parent plugin's API.
* While the parent plugin is designed for general-purpose file manipulation (CRUD operations), this extension is specifically engineered for **AI knowledge retrieval**. It abstracts away raw files and instead provides MCP tools (`query_wiki`, `get_wiki`, `wiki_card`) tailored for agentic workflows, complete with semantic ranking and graph exploration.

## Installation via GitHub Releases

When downloading this plugin from the GitHub Releases page, you will notice two different sets of artifacts available for every release version. They are explicitly separated so they do not contaminate each other:

1. **Standard Artifacts (`main.js`, `manifest.json`, `styles.css`)**
   * These are the loose files meant for standard Obsidian usage. 
   * **How to install:** Create a folder named `obsidian-local-rest-api-second-brain-api-extension` inside your vault's `.obsidian/plugins/` directory, and place these three files inside it.
   * **Use case:** Maximum safety and compatibility across all platforms (Single Core execution).

2. **Native Artifact (`native.zip`)**
   * This zip file contains a pre-configured plugin directory (`obsidian-local-rest-api-second-brain-mcp-extension-native`) which includes the `main.js`, `manifest.json`, and `styles.css`, but critically includes a pruned `node_modules` directory containing pre-compiled C++ binaries.
   * **How to install:** Extract the contents of this zip file directly into your vault's `.obsidian/plugins/` directory. It will automatically create the properly named plugin folder for you.
   * **Use case:** Power users who want to unlock maximum multi-core CPU performance for indexing. (See "Performance Notes" below).

## Manual Installation
1. Fork this repository.
2. Update `main.ts` to advertise your new route(s).
3. Build the project with `npm run build` (or `npm run dev` if you are iterating on some changes).
4. Link the plugin into your Obsidian vault's `.obsidian/plugins` directory.  On linux or osx, you can run `ln -s /path/to/your/cloned/fork /path/to/your/vault/.obsidian/plugins`.

## Performance Notes

Due to strict browser security constraints within Obsidian's Electron environment (specifically the disabling of `SharedArrayBuffer`), WebAssembly multi-threading is completely blocked. Furthermore, the Hugging Face WebGPU backend is currently unsupported or highly unstable in this context. Consequently, the default build of this plugin is forced to rely on a single CPU core for embedding generation to remain a safe, pure-JavaScript cross-platform plugin suitable for the Community Directory.

While the initial indexing of your vault may take some time in single-core mode, all generated embeddings are cached locally, ensuring that all subsequent queries are lightning fast.

### Unlocking Multi-Core Performance (Native Build)

If you are running this plugin locally and want to bypass Obsidian's browser sandbox to unlock full multi-core CPU performance for indexing, this project features a dual-build architecture.

By running the native build command, the plugin will compile using the native `onnxruntime-node` C++ binary instead of WebAssembly, restoring full multi-threading:

1. Build the native bundle:
   ```bash
   npm run build:native
   ```
2. Because the native C++ binaries cannot be bundled into a single `main.js` file, you must copy the local `node_modules` dependencies into your vault's plugin folder so the plugin can resolve them at runtime:
   ```bash
   cp -rL node_modules/ /path/to/your/vault/.obsidian/plugins/obsidian-local-rest-api-second-brain-api-extension/
   ```
3. Restart Obsidian. The plugin will detect the native build and log `Initializing pipeline in Native Multi-Core mode...` in your developer console.

**Standard Build Commands:**
* `npm run build`: Compiles the standard, pure-JS, single-core package for Obsidian community distribution.
* `npm run dev`: Watches files and builds the standard package on changes.
* `npm run build:native`: Compiles the high-performance, multi-core native package.
* `npm run dev:native`: Watches files and builds the native package on changes.
