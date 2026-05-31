import { Plugin, TFile, PluginSettingTab, Setting, App, FileSystemAdapter, Notice } from "obsidian";
import { getAPI, LocalRestApiPublicApi } from "obsidian-local-rest-api";
import * as crypto from "crypto";

interface SecondBrainPluginSettings {
	modelName: string;
	customModelName: string;
	cachedModelName: string;
	returnDiagnosticLogs: boolean;
	wikiPurpose: string;
	allowedPathPatterns: string[];
	excludedPathPatterns: string[];
}

const DEFAULT_SETTINGS: SecondBrainPluginSettings = {
	modelName: "Xenova/all-MiniLM-L6-v2",
	customModelName: "",
	cachedModelName: "",
	returnDiagnosticLogs: false,
	wikiPurpose: "",
	allowedPathPatterns: ["^wiki/"],
	excludedPathPatterns: ["^wiki/index\\.md$", "^wiki/log\\.md$"]
};

export default class ObsidianLocalRESTAPISecondBrainPlugin extends Plugin {
	private api!: LocalRestApiPublicApi;
	settings!: SecondBrainPluginSettings;
	private extractor: any = null;
	private hnswIndex: any = null;
	private embeddingCache: Map<string, number[]> = new Map();
	private fileHashMap: Map<string, string> = new Map();
	private idToPathMap: Map<number, string> = new Map();
	private initPromise: Promise<void> | null = null;

	private resolvedPluginDir: string = "";

	getPluginDirRelative(): string {
		if (this.resolvedPluginDir) {
			return this.resolvedPluginDir;
		}
		return `.obsidian/plugins/${this.manifest.id}`;
	}

	async resolvePluginDirectory() {
		try {
			const adapter = this.app.vault.adapter;
			const listResult = await adapter.list(".obsidian/plugins");
			for (const folder of listResult.folders) {
				const manifestPath = `${folder}/manifest.json`;
				if (await adapter.exists(manifestPath)) {
					try {
						const manifestContent = await adapter.read(manifestPath);
						const manifest = JSON.parse(manifestContent);
						if (manifest.id === this.manifest.id) {
							this.resolvedPluginDir = folder.replace(/\\/g, "/");
							console.log(`[Second Brain MCP] Successfully resolved plugin directory in vault: ${this.resolvedPluginDir}`);
							return;
						}
					} catch (e) {
						// Skip other plugins' manifest read/parse issues
					}
				}
			}
		} catch (err) {
			console.error("[Second Brain MCP] Failed to auto-resolve plugin directory from vault adapter:", err);
		}
		// Fallback if anything goes wrong
		this.resolvedPluginDir = `.obsidian/plugins/${this.manifest.id}`;
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	isPathAllowed(path: string): boolean {
		const normalizedPath = path.replace(/\\/g, "/");
		const normalizedPathLower = normalizedPath.toLowerCase();

		// Check allowed patterns
		let isAllowed = !this.settings.allowedPathPatterns || this.settings.allowedPathPatterns.length === 0;
		if (this.settings.allowedPathPatterns) {
			for (const pattern of this.settings.allowedPathPatterns) {
				if (!pattern.trim()) continue;
				try {
					const regex = new RegExp(pattern, "i");
					if (regex.test(normalizedPath)) {
						isAllowed = true;
						break;
					}
				} catch (e) {
					// Fallback to case-insensitive substring match
					if (normalizedPathLower.includes(pattern.toLowerCase())) {
						isAllowed = true;
						break;
					}
				}
			}
		}

		if (!isAllowed) {
			return false;
		}

		// Check excluded patterns
		if (this.settings.excludedPathPatterns) {
			for (const pattern of this.settings.excludedPathPatterns) {
				if (!pattern.trim()) continue;
				try {
					const regex = new RegExp(pattern, "i");
					if (regex.test(normalizedPath)) {
						return false;
					}
				} catch (e) {
					// Fallback to case-insensitive substring match
					if (normalizedPathLower.includes(pattern.toLowerCase())) {
						return false;
					}
				}
			}
		}

		return true;
	}

	registerRoutes() {
		// Here is how you register your routes:
		//
		// 1. Get an API handle:
		this.api = getAPI(this.app, this.manifest);

		// 2. Add your routes -- `addRoute` returns a route object
		//    https://www.geeksforgeeks.org/express-js-router-route-function/
		//    that you can attach handlers to
		this.api.addRoute("/second-brain-mcp/")
			.get((request, response) => {
				response.status(200).json({
					mcp_server: "second-brain-mcp",
					status: "running",
					transport: "Streamable HTTP (stateless)"
				});
			})
			.post(async (request, response) => {
				try {
					let body = request.body;
					if (typeof body === "string") {
						body = JSON.parse(body);
					} else if (Buffer.isBuffer(body)) {
						body = JSON.parse(body.toString("utf-8"));
					}

					if (!body || typeof body !== "object") {
						return response.status(400).json({
							jsonrpc: "2.0",
							error: {
								code: -32700,
								message: "Parse error"
							},
							id: null
						});
					}

					const { jsonrpc, method, params, id } = body;

					if (jsonrpc !== "2.0") {
						return response.status(400).json({
							jsonrpc: "2.0",
							error: {
								code: -32600,
								message: "Invalid Request: expected jsonrpc: '2.0'"
							},
							id: id || null
						});
					}

					switch (method) {
						case "initialize": {
							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {
									protocolVersion: "2024-11-05",
									capabilities: {
										tools: {}
									},
									serverInfo: {
										name: "second-brain-mcp",
										version: "1.0.0"
									}
								}
							});
						}

						case "notifications/initialized": {
							return response.status(204).end();
						}

						case "tools/list": {
							const purposeSuffix = this.settings.wikiPurpose ? ` (specialized for: ${this.settings.wikiPurpose})` : "";
							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {
									tools: [
										{
											name: "wiki_card",
											description: "Retrieve the scope and capabilities of the knowledge contained in this MCP server" + (purposeSuffix ? purposeSuffix + "." : "."),
											inputSchema: {
												type: "object",
												properties: {}
											}
										},
										{
											name: "query_wiki",
											description: "Query the second brain / wiki" + purposeSuffix,
											inputSchema: {
												type: "object",
												properties: {
													query: {
														type: "string",
														description: "The search query to run against the wiki"
													},
													root_limit: {
														type: "integer",
														description: "Maximum number of root files that should be included from the search (default: 5, minimum: 1)"
													},
													branch_factor: {
														type: "integer",
														description: "Maximum number of connections to traverse per node, ranked by similarity to query (default: 2)"
													},
													depth_limit: {
														type: "integer",
														description: "Maximum BFS depth to traverse (0 = root nodes only, 1 = direct connections, etc., default: 2)"
													},
													total_limit: {
														type: "integer",
														description: "Strict cap on the total number of unique pages returned (default: 20)"
													}
												},
												required: ["query"]
											}
										},
										{
											name: "get_wiki",
											description: "Retrieve a specific wiki page by its path or filename" + (purposeSuffix ? purposeSuffix + "." : "."),
											inputSchema: {
												type: "object",
												properties: {
													path: {
														type: "string",
														description: "The path or filename of the wiki note (if the extension or folder paths is omitted, the matching will be based on best effort)"
													}
												},
												required: ["path"]
											}
										}
									]
								}
							});
						}

						case "tools/call": {
							if (!params || typeof params !== "object" || (params.name !== "query_wiki" && params.name !== "get_wiki" && params.name !== "wiki_card")) {
								return response.status(400).json({
									jsonrpc: "2.0",
									error: {
										code: -32601,
										message: `Method not found: ${params?.name || method}`
									},
									id: id
								});
							}

							if (params.name === "wiki_card") {
								const debugLogs: string[] = [];
								const logDebug = (msg: string, isError = false) => {
									if (isError) {
										console.error(msg);
									} else {
										console.log(msg);
									}
									debugLogs.push(msg);
								};

								logDebug(`[Second Brain MCP] Initiating wiki_card.`);

								let cardFile: TFile | null = null;

								// 1. Try to find wiki-card.md in the root
								const rootCard = this.app.vault.getAbstractFileByPath("wiki-card.md");
								if (rootCard instanceof TFile) {
									cardFile = rootCard;
								}

								// 2. Try to find any file named wiki-card.md in the vault (case-insensitive)
								if (!cardFile) {
									const allFiles = this.app.vault.getMarkdownFiles();
									for (const f of allFiles) {
										if (f.name.toLowerCase() === "wiki-card.md") {
											cardFile = f;
											break;
										}
									}
								}

								// 3. Fallback: return the first TFile found in the root of the vault
								if (!cardFile) {
									const rootChildren = this.app.vault.getRoot().children;
									for (const child of rootChildren) {
										if (child instanceof TFile) {
											cardFile = child;
											break;
										}
									}
								}

								let yamlResult = "";
								if (cardFile) {
									logDebug(`[Second Brain MCP] Resolved wiki card file: "${cardFile.path}"`);
									const content = await this.app.vault.cachedRead(cardFile);
									yamlResult += `path: ${cardFile.path.replace(/\\/g, "/")}\n`;
									const contentLines = content.split("\n");
									yamlResult += `content: |\n`;
									for (const line of contentLines) {
										yamlResult += `  ${line}\n`;
									}
								} else {
									logDebug(`[Second Brain MCP] No wiki-card.md or root file could be found in the vault.`, true);
									yamlResult = `# No wiki card or root file found\n`;
								}

								if (this.settings.returnDiagnosticLogs) {
									yamlResult += "\n# Diagnostic Logs:\n";
									for (const log of debugLogs) {
										yamlResult += `# - ${log.replace(/\n/g, "\n#   ")}\n`;
									}
								}

								return response.status(200).json({
									jsonrpc: "2.0",
									id: id,
									result: {
										content: [
											{
												type: "text",
												text: yamlResult
											}
										]
									}
								});
							}

							if (params.name === "get_wiki") {
								const pathInput = params.arguments?.path;
								if (typeof pathInput !== "string") {
									return response.status(400).json({
										jsonrpc: "2.0",
										error: {
											code: -32602,
											message: "Invalid params: path must be a string"
										},
										id: id
									});
								}

								const debugLogs: string[] = [];
								const logDebug = (msg: string, isError = false) => {
									if (isError) {
										console.error(msg);
									} else {
										console.log(msg);
									}
									debugLogs.push(msg);
								};

								logDebug(`[Second Brain MCP] Initiating get_wiki. Path input: "${pathInput}"`);

								const file = this.resolveWikiFile(pathInput);
								if (!file) {
									logDebug(`[Second Brain MCP] Wiki file not found for path input: "${pathInput}"`, true);
									let errorYaml = `# Wiki page not found: ${pathInput}\n`;
									if (this.settings.returnDiagnosticLogs) {
										errorYaml += "\n# Diagnostic Logs:\n";
										for (const log of debugLogs) {
											errorYaml += `# - ${log.replace(/\n/g, "\n#   ")}\n`;
										}
									}
									return response.status(200).json({
										jsonrpc: "2.0",
										id: id,
										result: {
											content: [
												{
													type: "text",
													text: errorYaml
												}
											]
										}
									});
								}

								logDebug(`[Second Brain MCP] Successfully resolved wiki file: "${file.path}"`);
								const fileContent = await this.app.vault.cachedRead(file);

								let yamlResult = `path: ${file.path.replace(/\\/g, "/")}\n`;
								const contentLines = fileContent.split("\n");
								yamlResult += `content: |\n`;
								for (const line of contentLines) {
									yamlResult += `  ${line}\n`;
								}

								if (this.settings.returnDiagnosticLogs) {
									yamlResult += "\n# Diagnostic Logs:\n";
									for (const log of debugLogs) {
										yamlResult += `# - ${log.replace(/\n/g, "\n#   ")}\n`;
									}
								}

								return response.status(200).json({
									jsonrpc: "2.0",
									id: id,
									result: {
										content: [
											{
												type: "text",
												text: yamlResult
											}
										]
									}
								});
							}

							// Otherwise, query_wiki
							const query = params.arguments?.query;
							let root_limit = typeof params.arguments?.root_limit === "number" ? params.arguments.root_limit : 5;
							let branch_factor = typeof params.arguments?.branch_factor === "number" ? params.arguments.branch_factor : 2;
							let depth_limit = typeof params.arguments?.depth_limit === "number" ? params.arguments.depth_limit : 2;
							let total_limit = typeof params.arguments?.total_limit === "number" ? params.arguments.total_limit : 20;

							// Clamp limits per design specs
							root_limit = Math.max(1, root_limit);
							branch_factor = Math.max(0, branch_factor);
							depth_limit = Math.max(0, depth_limit);
							total_limit = Math.max(1, total_limit);

							if (typeof query !== "string") {
								return response.status(400).json({
									jsonrpc: "2.0",
									error: {
										code: -32602,
										message: "Invalid params: query must be a string"
									},
									id: id
								});
							}

							const debugLogs: string[] = [];
							const logDebug = (msg: string, isError = false) => {
								if (isError) {
									console.error(msg);
								} else {
									console.log(msg);
								}
								debugLogs.push(msg);
							};

							logDebug(`[Second Brain MCP] Initiating query_wiki. Query: "${query}", root_limit: ${root_limit}, branch_factor: ${branch_factor}, depth_limit: ${depth_limit}, total_limit: ${total_limit}`);

							// Ensure search engine is initialized
							let searchEngineReady = false;
							try {
								await this.initializeSearchEngine(logDebug);
								searchEngineReady = true;
							} catch (err) {
								logDebug(`[Second Brain MCP] Failed to initialize semantic search engine. Error: ${err}`, true);
							}

							logDebug(`[Second Brain MCP] Search engine status: searchEngineReady = ${searchEngineReady}, cacheSize = ${this.embeddingCache.size}, hasHnswIndex = ${!!this.hnswIndex}`);

							// Pre-generate query embedding
							let queryEmbedding: number[] = [];
							if (searchEngineReady) {
								try {
									queryEmbedding = await this.generateEmbedding(query);
									logDebug(`[Second Brain MCP] Generated query embedding. Length: ${queryEmbedding.length}`);
								} catch (err) {
									logDebug(`[Second Brain MCP] Error generating query embedding: ${err}`, true);
								}
							}

							const matchedRoots: TFile[] = [];

							if (searchEngineReady && this.hnswIndex && queryEmbedding.length > 0) {
								// HNSW vector search for parent / root nodes
								logDebug(`[Second Brain MCP] Running HNSW vector search with root_limit = ${root_limit}`);
								const searchResults = this.hnswIndex.searchKNN(queryEmbedding, root_limit);
								logDebug(`[Second Brain MCP] HNSW raw search results (count: ${searchResults.length}): ${JSON.stringify(searchResults)}`);
								for (const res of searchResults) {
									const path = this.idToPathMap.get(res.id);
									if (path) {
										const file = this.app.vault.getAbstractFileByPath(path);
										if (file instanceof TFile) {
											matchedRoots.push(file);
										}
									}
								}
								logDebug(`[Second Brain MCP] HNSW search matched ${matchedRoots.length} root nodes.`);
							} else {
								logDebug("[Second Brain MCP] HNSW Index or Query Embedding not ready, search returning 0 matches.", true);
							}

							// Setup queue and tracker sets for BFS graph traversal
							interface BFSNode {
								file: TFile;
								depth: number;
							}

							const queue: BFSNode[] = [];
							const visited = new Set<string>();
							const queued = new Set<string>();

							// Push initial roots to queue
							for (const file of matchedRoots) {
								const normPath = file.path.replace(/\\/g, "/");
								if (!queued.has(normPath)) {
									queued.add(normPath);
									queue.push({ file, depth: 0 });
								}
							}

							// Final list of visited nodes to keep track of their path, content and child connections
							interface TraversedItem {
								path: string;
								content: string;
								connections: { path: string; content: string }[];
							}
							const traversedItems: TraversedItem[] = [];

							// BFS Traversal Loop
							while (queue.length > 0 && traversedItems.length < total_limit) {
								const currentNode = queue.shift()!;
								const normPath = currentNode.file.path.replace(/\\/g, "/");

								if (visited.has(normPath)) {
									continue;
								}
								visited.add(normPath);

								let fileContent = "";
								try {
									fileContent = await this.app.vault.cachedRead(currentNode.file);
								} catch (err) {
									logDebug(`[Second Brain MCP] Failed to read file ${normPath}: ${err}`, true);
									continue;
								}

								// Find bidirectional connections
								const resolvedLinks = this.app.metadataCache.resolvedLinks;

								// 1. Outgoing links
								const outgoingPaths = Object.keys(resolvedLinks[currentNode.file.path] || {});

								// 2. Incoming backlinks
								const backlinkPaths: string[] = [];
								for (const [sourcePath, destinations] of Object.entries(resolvedLinks)) {
									if (destinations[currentNode.file.path]) {
										backlinkPaths.push(sourcePath);
									}
								}

								// Combine and filter unique valid connections
								const uniqueConnPaths = Array.from(new Set([...outgoingPaths, ...backlinkPaths]));
								const validConnFiles: TFile[] = [];
								for (const connPath of uniqueConnPaths) {
									const normalizedConnPath = connPath.replace(/\\/g, "/");
									const normalizedConnPathLower = normalizedConnPath.toLowerCase();

									if (!this.isPathAllowed(connPath)) {
										continue;
									}

									const connFile = this.app.vault.getAbstractFileByPath(connPath);
									if (connFile instanceof TFile) {
										validConnFiles.push(connFile);
									}
								}

								// Calculate semantic ranking for child connections if we have valid query embedding
								let selectedConns: TFile[] = [];
								if (validConnFiles.length > 0) {
									if (searchEngineReady && queryEmbedding.length > 0) {
										const scoredConns = await Promise.all(
											validConnFiles.map(async (connFile) => {
												const normalizedConnPath = connFile.path.replace(/\\/g, "/");
												let connEmbedding = this.embeddingCache.get(normalizedConnPath);

												if (!connEmbedding) {
													try {
														const connContent = await this.app.vault.cachedRead(connFile);
														const strippedConn = stripFrontmatter(connContent);
														connEmbedding = await this.generateEmbedding(strippedConn);
														this.embeddingCache.set(normalizedConnPath, connEmbedding);
													} catch (err) {
														connEmbedding = new Array(queryEmbedding.length).fill(0);
													}
												}

												const score = dotProduct(queryEmbedding, connEmbedding!);
												return { connFile, score };
											})
										);

										// Sort descending by score
										scoredConns.sort((a, b) => b.score - a.score);
										selectedConns = scoredConns.slice(0, branch_factor).map(item => item.connFile);
									} else {
										selectedConns = validConnFiles.slice(0, branch_factor);
									}
								}

								// Queue child connections for next depth level if within depth_limit
								if (currentNode.depth < depth_limit) {
									for (const childFile of selectedConns) {
										const childNormPath = childFile.path.replace(/\\/g, "/");
										if (!visited.has(childNormPath) && !queued.has(childNormPath)) {
											queued.add(childNormPath);
											queue.push({ file: childFile, depth: currentNode.depth + 1 });
										}
									}
								}

								// Map the immediate traversed connections content
								const connections: { path: string; content: string }[] = [];
								for (const connFile of selectedConns) {
									try {
										const connContent = await this.app.vault.cachedRead(connFile);
										connections.push({
											path: connFile.path.replace(/\\/g, "/"),
											content: connContent
										});
									} catch (err) {
										// Ignore read errors for connections
									}
								}

								traversedItems.push({
									path: normPath,
									content: fileContent,
									connections: connections
								});
							}

							logDebug(`[Second Brain MCP] BFS Traversal complete. Total matched unique files: ${traversedItems.length}`);

							let yamlResult = "";
							for (const item of traversedItems) {
								yamlResult += `- path: ${item.path}\n`;

								const contentLines = item.content.split("\n");
								yamlResult += `  content: |\n`;
								for (const line of contentLines) {
									yamlResult += `    ${line}\n`;
								}

								if (item.connections.length > 0) {
									yamlResult += `  connections:\n`;
									for (const conn of item.connections) {
										yamlResult += `    - path: ${conn.path}\n`;
										const connLines = conn.content.split("\n");
										yamlResult += `      content: |\n`;
										for (const line of connLines) {
											yamlResult += `        ${line}\n`;
										}
									}
								}
							}

							if (yamlResult === "") {
								yamlResult = "# No matching files found\n";
							}

							// Append diagnostic logs to the YAML output if enabled
							if (this.settings.returnDiagnosticLogs) {
								yamlResult += "\n# Diagnostic Logs:\n";
								for (const log of debugLogs) {
									yamlResult += `# - ${log.replace(/\n/g, "\n#   ")}\n`;
								}
							}

							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {
									content: [
										{
											type: "text",
											text: yamlResult
										}
									]
								}
							});
						}

						case "ping": {
							return response.status(200).json({
								jsonrpc: "2.0",
								id: id,
								result: {}
							});
						}

						default: {
							if (method.endsWith("/list")) {
								return response.status(200).json({
									jsonrpc: "2.0",
									id: id,
									result: {
										[method.split("/")[0]]: []
									}
								});
							}

							return response.status(404).json({
								jsonrpc: "2.0",
								error: {
									code: -32601,
									message: `Method not found: ${method}`
								},
								id: id
							});
						}
					}

				} catch (error) {
					console.error("MCP Server Error:", error);
					return response.status(500).json({
						jsonrpc: "2.0",
						error: {
							code: -32603,
							message: error instanceof Error ? error.message : "Internal error"
						},
						id: null
					});
				}
			});

		// For more insight into what you can put into a route, have
		// a look at the existing routes that are handled by
		// the API itself: https://github.com/coddingtonbear/obsidian-local-rest-api/blob/main/src/requestHandler.ts
	}

	//
	//
	//
	//
	// Everything below this point can be left as it is -- this is just
	// setting up machinery to properly register your routes with
	// Obsidian Local REST API
	//
	//
	//
	//

	async onload() {
		await this.loadSettings();
		await this.resolvePluginDirectory();

		this.addSettingTab(new ObsidianLocalRESTAPISecondBrainSettingsTab(this.app, this));

		this.initializeSearchEngine().catch((err) => {
			console.error("[Second Brain MCP] Initial search engine startup failed:", err);
		});

		if (this.app.plugins.enabledPlugins.has("obsidian-local-rest-api")) {
			this.registerRoutes();
		}

		this.registerEvent(
			this.app.workspace.on(
				"obsidian-local-rest-api:loaded",
				this.registerRoutes.bind(this)
			)
		);

		this.registerEvent(
			this.app.vault.on("modify", async (file) => {
				if (file instanceof TFile) {
					await this.updateFileEmbedding(file);
				}
			})
		);

		this.registerEvent(
			this.app.vault.on("delete", async (file) => {
				await this.onFileDeleted(file.path);
			})
		);
	}

	onunload() {
		if (this.api) {
			(this.api as any).unregister();
		}
	}

	async reinitializeSearchEngine() {
		this.extractor = null;
		this.hnswIndex = null;
		this.embeddingCache.clear();
		this.fileHashMap.clear();
		this.idToPathMap.clear();
		this.initPromise = null;
		this.settings.cachedModelName = "";
		await this.saveSettings();
		await this.initializeSearchEngine();
	}

	async initializeSearchEngine(logFn?: (msg: string, isError?: boolean) => void) {
		const localLog = logFn || ((msg: string, isError?: boolean) => isError ? console.error(msg) : console.log(msg));

		if (this.initPromise) {
			return this.initPromise;
		}

		this.initPromise = (async () => {
			try {
				let modelToLoad = this.settings.cachedModelName;
				if (!modelToLoad) {
					modelToLoad = this.settings.modelName === "custom"
						? this.settings.customModelName
						: this.settings.modelName;
				}

				if (!modelToLoad) {
					localLog("[Second Brain MCP] No embedding model configured yet.");
					return;
				}

				localLog(`[Second Brain MCP] Initializing search engine with model: ${modelToLoad}`);

				localLog(`[Second Brain MCP] Requiring @huggingface/transformers`);
				let tfModule;
				try {
					tfModule = require("@huggingface/transformers");
				} catch (reqErr) {
					if (process.env.IS_NATIVE_BUILD === "true") {
						const path = require("path");
						const basePath = (this.app.vault.adapter as any).getBasePath();
						const pluginDir = this.manifest.dir;
						const modulePath = path.join(basePath, pluginDir, "node_modules", "@huggingface", "transformers");
						localLog(`[Second Brain MCP] Failed to require by module name. Trying absolute path: ${modulePath}`);
						tfModule = require(modulePath);
					} else {
						throw reqErr;
					}
				}
				localLog(`[Second Brain MCP] tfModule keys: ${Object.keys(tfModule).join(", ")}`);

				const pipeline = tfModule.pipeline || (tfModule as any).default?.pipeline;
				const env = tfModule.env || (tfModule as any).default?.env;

				if (!pipeline) {
					throw new Error("Failed to resolve 'pipeline' from @huggingface/transformers module.");
				}

				if (env) {
					try {
						// Configure env to disable local filesystem models
						env.allowLocalModels = false;
						if (env.backends?.onnx?.wasm) {
							// Let ONNX Runtime use its default multi-threading behavior
							// env.backends.onnx.wasm.numThreads = 1;
						}
						localLog("[Second Brain MCP] Transformers env successfully configured.");
					} catch (envErr) {
						localLog(`[Second Brain MCP] Warning configuring Transformers env: ${envErr}`, true);
					}
				} else {
					localLog("[Second Brain MCP] Warning: 'env' object not found in @huggingface/transformers module, skipping environment override.", true);
				}

				// Load feature-extraction pipeline (forced to CPU due to WebGPU unavailability and caching bugs)
				if (process.env.IS_NATIVE_BUILD === "true") {
					localLog(`[Second Brain MCP] Initializing pipeline in Native Multi-Core mode...`);
				} else {
					localLog(`[Second Brain MCP] Initializing pipeline in Pure JS Compatibility mode (Single Core)...`);
				}
				this.extractor = await pipeline("feature-extraction", modelToLoad, { device: "cpu" });
				localLog("[Second Brain MCP] Transformer model loaded successfully.");

				// Pre-index all files
				await this.indexAllFiles(logFn);

				this.settings.cachedModelName = modelToLoad;
				await this.saveSettings();

				localLog("[Second Brain MCP] Search engine initialization complete.");
			} catch (err) {
				localLog(`[Second Brain MCP] Failed to initialize search engine: ${err}`, true);
				this.initPromise = null; // Let it retry next time
				throw err;
			}
		})();

		return this.initPromise;
	}

	async indexAllFiles(logFn?: (msg: string, isError?: boolean) => void) {
		const localLog = logFn || ((msg: string, isError?: boolean) => isError ? console.error(msg) : console.log(msg));
		const allFiles = this.app.vault.getMarkdownFiles();
		this.embeddingCache.clear();
		this.fileHashMap.clear();

		localLog(`[Second Brain MCP] Indexing all ${allFiles.length} files in the vault.`);

		const diskCache = await this.loadEmbeddingCache();
		let cacheHitCount = 0;
		let cacheMissCount = 0;

		for (const file of allFiles) {
			const normalizedPath = file.path.replace(/\\/g, "/");
			const normalizedPathLower = normalizedPath.toLowerCase();

			if (!this.isPathAllowed(file.path)) {
				continue;
			}

			try {
				const content = await this.app.vault.cachedRead(file);
				const stripped = stripFrontmatter(content);
				const fileHash = crypto.createHash("md5").update(stripped).digest("hex");

				// Try to load from disk cache first using file content MD5 hash integrity check
				if (diskCache && diskCache[normalizedPath] && diskCache[normalizedPath].hash === fileHash) {
					this.embeddingCache.set(normalizedPath, diskCache[normalizedPath].vector);
					this.fileHashMap.set(normalizedPath, fileHash);
					cacheHitCount++;
					continue;
				}

				// Cache miss: generate embedding
				const embedding = await this.generateEmbedding(stripped);
				this.embeddingCache.set(normalizedPath, embedding);
				this.fileHashMap.set(normalizedPath, fileHash);
				cacheMissCount++;
			} catch (err) {
				localLog(`[Second Brain MCP] Error indexing file ${file.path}: ${err}`, true);
			}
		}

		localLog(`[Second Brain MCP] Vault indexing finished. Cache hits: ${cacheHitCount}, Cache misses (recalculated): ${cacheMissCount}.`);

		// Rebuild HNSW index
		await this.rebuildHNSWIndex(logFn);

		// If there were any misses (new/modified files), save the updated cache to disk
		if (cacheMissCount > 0) {
			await this.saveEmbeddingCache();
		}
	}

	async generateEmbedding(text: string): Promise<number[]> {
		if (!this.extractor) {
			throw new Error("Extractor is not initialized");
		}
		// Empty strings can cause model issues, use a fallback
		const queryText = text.trim() === "" ? "empty" : text;
		const output = await this.extractor(queryText, { pooling: "mean", normalize: true });
		return Array.from(output.data as Float32Array);
	}

	async rebuildHNSWIndex(logFn?: (msg: string, isError?: boolean) => void) {
		const localLog = logFn || ((msg: string, isError?: boolean) => isError ? console.error(msg) : console.log(msg));
		this.idToPathMap.clear();
		const HNSWClass = (await import("hnsw")).HNSW;

		// Auto-detect dimension from caching embeddings, fallback to 384
		let dimension = 384;
		if (this.embeddingCache.size > 0) {
			const firstVal = this.embeddingCache.values().next().value;
			if (firstVal) {
				dimension = firstVal.length;
			}
		}

		// new HNSW(M, efConstruction, d, metric, efSearch)
		this.hnswIndex = new HNSWClass(16, 200, dimension, "cosine", 50);

		const data: { id: number; vector: number[] }[] = [];
		let indexCounter = 0;

		for (const [path, vector] of this.embeddingCache.entries()) {
			const id = indexCounter++;
			this.idToPathMap.set(id, path);
			data.push({ id, vector });
		}

		if (data.length > 0) {
			await this.hnswIndex.buildIndex(data);
		}
		localLog(`[Second Brain MCP] HNSW Index rebuilt with ${data.length} documents.`);
	}

	async updateFileEmbedding(file: TFile) {
		const normalizedPath = file.path.replace(/\\/g, "/");
		const normalizedPathLower = normalizedPath.toLowerCase();

		if (!this.isPathAllowed(file.path)) {
			return;
		}

		try {
			if (!this.extractor) return;

			const content = await this.app.vault.cachedRead(file);
			const stripped = stripFrontmatter(content);
			const fileHash = crypto.createHash("md5").update(stripped).digest("hex");

			// Skip re-calculation if the content has not changed
			if (this.fileHashMap.get(normalizedPath) === fileHash) {
				return;
			}

			const embedding = await this.generateEmbedding(stripped);
			this.embeddingCache.set(normalizedPath, embedding);
			this.fileHashMap.set(normalizedPath, fileHash);
			await this.rebuildHNSWIndex();
			await this.saveEmbeddingCache();
		} catch (err) {
			console.error(`[Second Brain MCP] Error updating embedding for ${file.path}:`, err);
		}
	}

	async onFileDeleted(path: string) {
		const normalizedPath = path.replace(/\\/g, "/");
		if (this.embeddingCache.delete(normalizedPath)) {
			await this.rebuildHNSWIndex();
			await this.saveEmbeddingCache();
		}
	}

	async loadEmbeddingCache(): Promise<Record<string, { hash: string; vector: number[] }> | null> {
		const cachePath = `${this.getPluginDirRelative()}/embeddings-cache.json`;
		const adapter = this.app.vault.adapter;

		if (!(await adapter.exists(cachePath))) {
			return null;
		}

		try {
			const cacheContent = await adapter.read(cachePath);
			const parsed = JSON.parse(cacheContent);

			const modelToLoad = this.settings.modelName === "custom"
				? this.settings.customModelName
				: this.settings.modelName;

			if (parsed.modelName === modelToLoad && parsed.embeddings) {
				return parsed.embeddings;
			}
		} catch (err) {
			console.error("[Second Brain MCP] Failed to load embeddings cache from disk:", err);
		}
		return null;
	}

	async saveEmbeddingCache() {
		const cachePath = `${this.getPluginDirRelative()}/embeddings-cache.json`;
		const adapter = this.app.vault.adapter;

		const modelToLoad = this.settings.modelName === "custom"
			? this.settings.customModelName
			: this.settings.modelName;

		const serializedEmbeddings: Record<string, { hash: string; vector: number[] }> = {};

		for (const [path, vector] of this.embeddingCache.entries()) {
			const hash = this.fileHashMap.get(path) || "";
			serializedEmbeddings[path] = {
				hash,
				vector
			};
		}

		try {
			const payload = {
				modelName: modelToLoad,
				embeddings: serializedEmbeddings
			};
			await adapter.write(cachePath, JSON.stringify(payload, null, 2));
		} catch (err) {
			console.error("[Second Brain MCP] Failed to save embeddings cache to disk:", err);
		}
	}

	resolveWikiFile(pathInput: string): TFile | null {
		const normalizedInput = pathInput.replace(/\\/g, "/");

		// 1. Try Obsidian's native link resolver
		let file = this.app.metadataCache.getFirstLinkpathDest(normalizedInput, "");
		if (file instanceof TFile) return file;

		// 2. Try raw vault paths
		let abstractFile = this.app.vault.getAbstractFileByPath(normalizedInput);
		if (abstractFile instanceof TFile) return abstractFile;

		abstractFile = this.app.vault.getAbstractFileByPath(normalizedInput + ".md");
		if (abstractFile instanceof TFile) return abstractFile;

		// 3. Fallback: Search all markdown files for a path suffix or filename match
		const allMarkdown = this.app.vault.getMarkdownFiles();
		const inputLower = normalizedInput.toLowerCase();
		const inputLowerNoExt = inputLower.endsWith(".md") ? inputLower.slice(0, -3) : inputLower;

		// Match suffix (e.g. "sources/peaa-030-miscellaneous-points" matching "wiki/sources/peaa-030-miscellaneous-points.md")
		for (const f of allMarkdown) {
			const fPathLower = f.path.replace(/\\/g, "/").toLowerCase();
			const fPathLowerNoExt = fPathLower.endsWith(".md") ? fPathLower.slice(0, -3) : fPathLower;

			if (fPathLower === inputLower || fPathLowerNoExt === inputLowerNoExt) {
				return f;
			}
			if (fPathLower.endsWith("/" + inputLower) || fPathLowerNoExt.endsWith("/" + inputLowerNoExt)) {
				return f;
			}
		}

		// Match exact filename (e.g. "peaa-030-miscellaneous-points" matching "wiki/sources/peaa-030-miscellaneous-points.md")
		const inputFilename = normalizedInput.substring(normalizedInput.lastIndexOf("/") + 1).toLowerCase();
		const inputFilenameNoExt = inputFilename.endsWith(".md") ? inputFilename.slice(0, -3) : inputFilename;
		for (const f of allMarkdown) {
			const fNameLower = f.name.toLowerCase();
			const fNameLowerNoExt = fNameLower.endsWith(".md") ? fNameLower.slice(0, -3) : fNameLower;

			if (fNameLower === inputFilename || fNameLowerNoExt === inputFilenameNoExt) {
				return f;
			}
		}

		return null;
	}
}

class ObsidianLocalRESTAPISecondBrainSettingsTab extends PluginSettingTab {
	plugin: ObsidianLocalRESTAPISecondBrainPlugin;

	constructor(app: App, plugin: ObsidianLocalRESTAPISecondBrainPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Second Brain MCP" });
		const desc = containerEl.createEl("p", { text: "This is a plugin for the Obsidian Local REST API plugin (you could call it a meta-plugin). While it was originally developed to complement the \"Second Brain\" idea, it has grown beyond that scope and is now a general-purpose wiki-querying MCP server. It uses semantic search to find relevant notes and a BFS search of the graph to find connected notes." });
		desc.style.lineHeight = '2';
		desc.style.textWrap = 'pretty';
		desc.style.backgroundColor = "var(--background-secondary-alt)";
		desc.style.border = "1px solid var(--background-modifier-border)";
		desc.style.borderRadius = "8px";
		desc.style.padding = "18px";
		desc.style.marginTop = "24px";
		desc.style.marginBottom = "24px";


		containerEl.createEl("h2", { text: "General Settings" });

		new Setting(containerEl)
			.setName("Wiki Purpose / Knowledge Domain")
			.setDesc("A brief sentence or phrase describing the knowledge domain of this wiki (e.g. 'Software Engineering Knowledge Base'). This is dynamically injected into the MCP tool descriptions so the LLM knows what specific knowledge is hosted here.")
			.addText((text) =>
				text
					.setPlaceholder("e.g. Software Engineering Knowledge Base")
					.setValue(this.plugin.settings.wikiPurpose)
					.onChange(async (value) => {
						this.plugin.settings.wikiPurpose = value.trim();
						configUpdaters.forEach(updater => updater());
						await this.plugin.saveSettings();
					})
			);

		const modelSettingsWrapper = containerEl.createDiv();
		modelSettingsWrapper.style.border = "1px solid var(--background-modifier-border)";
		modelSettingsWrapper.style.borderRadius = "8px";
		modelSettingsWrapper.style.padding = "18px";
		modelSettingsWrapper.style.marginTop = "24px";
		modelSettingsWrapper.style.marginBottom = "24px";

		new Setting(modelSettingsWrapper)
			.setName("Embedding Model")
			.setDesc("Select the local model used to generate embeddings for semantic search.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("Xenova/all-MiniLM-L6-v2", "all-MiniLM-L6-v2 (Light, 384 dim)")
					.addOption("Xenova/bge-small-en-v1.5", "bge-small-en-v1.5 (High Accuracy English, 384 dim)")
					.addOption("nomic-ai/nomic-embed-text-v1.5", "nomic-embed-text-v1.5 (Large Context, 768 dim)")
					.addOption("custom", "Custom Model Path (Specify Below)")
					.setValue(this.plugin.settings.modelName)
					.onChange(async (value) => {
						this.plugin.settings.modelName = value;
						await this.plugin.saveSettings();
						this.display(); // re-render to toggle custom path field visibility
					})
			);

		if (this.plugin.settings.modelName === "custom") {
			new Setting(modelSettingsWrapper)
				.setName("Custom Model Path")
				.setDesc("Enter the Hugging Face model path (e.g. Xenova/all-MiniLM-L6-v2).")
				.addText((text) =>
					text
						.setPlaceholder("Enter model path")
						.setValue(this.plugin.settings.customModelName)
						.onChange(async (value) => {
							this.plugin.settings.customModelName = value.trim();
						})
				)
				.addButton((button) =>
					button
						.setButtonText("Apply")
						.setCta()
						.onClick(async () => {
							await this.plugin.saveSettings();
							this.display();
						})
				);
		}

		const currentModelToLoad = this.plugin.settings.modelName === "custom" ? this.plugin.settings.customModelName : this.plugin.settings.modelName;
		if (this.plugin.settings.cachedModelName && currentModelToLoad && currentModelToLoad !== this.plugin.settings.cachedModelName) {
			const warningNote = modelSettingsWrapper.createEl("div", {
				text: "Warning: The selected model is different from the one currently running and cached. You must click 'Clear Cache' below to apply your new model selection."
			});
			warningNote.style.lineHeight = '2';
			warningNote.style.textWrap = 'pretty';
			warningNote.style.backgroundColor = "var(--background-secondary-alt)";
			warningNote.style.border = "1px solid var(--text-error)";
			warningNote.style.borderRadius = "8px";
			warningNote.style.padding = "18px";
			warningNote.style.marginTop = "24px";
			warningNote.style.marginBottom = "24px";
			warningNote.style.color = "var(--text-error)";
		}

		new Setting(containerEl)
			.setName("Return Diagnostic Logs")
			.setDesc("Include detailed execution logs in the tool response (used for debugging).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.returnDiagnosticLogs)
					.onChange(async (value) => {
						this.plugin.settings.returnDiagnosticLogs = value;
						await this.plugin.saveSettings();
					})
			);

		const configUpdaters: (() => void)[] = [];

		const parentPlugin = (this.app as any).plugins.plugins["obsidian-local-rest-api"];
		if (parentPlugin && parentPlugin.settings) {
			const parentSettings = parentPlugin.settings;
			const authHeaderName = parentSettings.authorizationHeaderName || "Authorization";
			const apiKey = parentSettings.apiKey || "API_KEY_NOT_FOUND";

			const createConfigJson = (url: string, currentWikiPurpose: string) => {
				let mcpKey = currentWikiPurpose.trim();
				if (!mcpKey) {
					mcpKey = "Obsidian MCP";
				}

				return JSON.stringify({
					mcpServers: {
						[mcpKey]: {
							url: url,
							transport: "http",
							headers: {
								[authHeaderName]: `Bearer ${apiKey}`
							}
						}
					}
				}, null, 2);
			};

			const renderConfigCodeBlock = (title: string, url: string) => {
				containerEl.createEl("h3", { text: title });
				let currentConfigStr = createConfigJson(url, this.plugin.settings.wikiPurpose);

				const wrapper = containerEl.createDiv();
				wrapper.style.position = "relative";
				wrapper.style.marginBottom = "24px";
				wrapper.style.backgroundColor = "var(--background-secondary)";
				wrapper.style.border = "1px solid var(--background-modifier-border)";
				wrapper.style.borderRadius = "8px";
				wrapper.style.padding = "16px";
				wrapper.style.paddingTop = "36px"; // Extra padding for copy button

				const pre = wrapper.createEl("pre");
				pre.style.margin = "0";
				pre.style.whiteSpace = "pre-wrap";
				const code = pre.createEl("code", { text: currentConfigStr });
				code.style.fontFamily = "var(--font-monospace)";
				code.style.fontSize = "0.9em";
				code.style.userSelect = "all";

				const copyBtn = wrapper.createEl("button", { text: "Copy" });
				copyBtn.style.position = "absolute";
				copyBtn.style.top = "8px";
				copyBtn.style.right = "8px";
				copyBtn.addEventListener("click", async () => {
					await navigator.clipboard.writeText(currentConfigStr);
					copyBtn.innerText = "Copied!";
					setTimeout(() => { copyBtn.innerText = "Copy"; }, 2000);
				});

				configUpdaters.push(() => {
					currentConfigStr = createConfigJson(url, this.plugin.settings.wikiPurpose);
					code.innerText = currentConfigStr;
				});
			};

			if (parentSettings.enableSecureServer !== false) {
				const port = parentSettings.port || 27124;
				renderConfigCodeBlock("MCP Configuration (Encrypted / HTTPS)", `https://127.0.0.1:${port}/second-brain-mcp/`);
			}

			if (parentSettings.enableInsecureServer) {
				const port = parentSettings.insecurePort || 27123;
				renderConfigCodeBlock("MCP Configuration (Non-encrypted / HTTP)", `http://127.0.0.1:${port}/second-brain-mcp/`);
			}
		}

		const pathSettingsWrapper = containerEl.createDiv();
		pathSettingsWrapper.style.border = "1px solid var(--background-modifier-border)";
		pathSettingsWrapper.style.borderRadius = "8px";
		pathSettingsWrapper.style.padding = "18px";
		pathSettingsWrapper.style.marginTop = "24px";
		pathSettingsWrapper.style.marginBottom = "24px";

		const pathFilteringHeader = pathSettingsWrapper.createEl("h2", { text: "Path & Filtering Settings" });
		pathFilteringHeader.style.marginTop = "0";

		const pathFilteringDesc = pathSettingsWrapper.createEl("p", {
			text: "Configure regular expressions or prefixes to specify which notes are included or excluded from your search index."
		});
		pathFilteringDesc.style.fontSize = "0.9em";
		pathFilteringDesc.style.color = "var(--text-muted)";
		pathFilteringDesc.style.marginBottom = "16px";

		const renderPatternList = (
			container: HTMLElement,
			title: string,
			desc: string,
			patternsList: string[],
			placeholder: string,
			saveCallback: () => Promise<void>
		) => {
			const titleEl = container.createEl("h3", { text: title });
			titleEl.style.marginTop = "18px";
			titleEl.style.marginBottom = "4px";

			const descEl = container.createEl("p", { text: desc });
			descEl.style.fontSize = "0.85em";
			descEl.style.color = "var(--text-muted)";
			descEl.style.marginBottom = "12px";
			descEl.style.marginTop = "0";
			descEl.style.display = "block";

			const listWrapper = container.createDiv();
			listWrapper.style.display = "flex";
			listWrapper.style.flexDirection = "column";
			listWrapper.style.gap = "8px";
			listWrapper.style.marginBottom = "12px";
			listWrapper.style.margin = "12px";

			patternsList.forEach((pattern, index) => {
				const row = listWrapper.createDiv();
				row.style.display = "flex";
				row.style.gap = "8px";
				row.style.alignItems = "center";

				const inputEl = row.createEl("input", {
					type: "text",
					value: pattern,
					placeholder: placeholder
				});
				inputEl.style.flexGrow = "1";
				inputEl.style.fontFamily = "var(--font-monospace)";
				inputEl.style.minWidth = "0";

				inputEl.addEventListener("change", async (e) => {
					patternsList[index] = (e.target as HTMLInputElement).value.trim();
					await saveCallback();
				});

				const removeBtn = row.createEl("button", {
					text: "Remove"
				});
				removeBtn.style.cursor = "pointer";
				removeBtn.addClass("mod-warning");
				removeBtn.addEventListener("click", async () => {
					patternsList.splice(index, 1);
					await saveCallback();
					this.display(); // Refresh Settings UI
				});
			});

			const addRow = container.createDiv();
			const addBtn = addRow.createEl("button", {
				text: "+ Add Pattern"
			});
			addBtn.style.cursor = "pointer";
			addBtn.addEventListener("click", async () => {
				patternsList.push("");
				await saveCallback();
				this.display(); // Refresh Settings UI
			});
		};

		renderPatternList(
			pathSettingsWrapper,
			"Allowed Path Patterns",
			"Regular expressions matching paths that are ALLOWED to be indexed. Leave empty to allow all paths. (Default: '^wiki/')",
			this.plugin.settings.allowedPathPatterns,
			"e.g. ^wiki/",
			async () => { await this.plugin.saveSettings(); }
		);

		renderPatternList(
			pathSettingsWrapper,
			"Excluded Path Patterns",
			"Regular expressions matching paths that are EXCLUDED from the index. (Default: '^wiki/index\\.md$', '^wiki/log\\.md$')",
			this.plugin.settings.excludedPathPatterns,
			"e.g. ^wiki/index\\.md$",
			async () => { await this.plugin.saveSettings(); }
		);

		const noteEl = pathSettingsWrapper.createEl("div", {
			text: "Note: Changing these filters alters which files are indexed. To apply changes immediately, use the 'Clear Cache' button below to trigger a full re-index."
		});
		noteEl.style.marginTop = "14px";
		noteEl.style.padding = "10px";
		noteEl.style.borderLeft = "4px solid var(--interactive-accent)";
		noteEl.style.backgroundColor = "var(--background-secondary)";
		noteEl.style.fontSize = "0.85em";
		noteEl.style.color = "var(--text-muted)";

		const note2El = pathSettingsWrapper.createEl("div", {
			text: "Note: The paths above are only for `query_wiki` and the `get_wiki` tool can return any document if the correct path is provided."
		});
		note2El.style.marginTop = "14px";
		note2El.style.padding = "10px";
		note2El.style.borderLeft = "4px solid var(--interactive-accent)";
		note2El.style.backgroundColor = "var(--background-secondary)";
		note2El.style.fontSize = "0.85em";
		note2El.style.color = "var(--text-muted)";

		const note3El = pathSettingsWrapper.createEl("div", {
			text: "Note: For a document to be returned by the `query_wiki` tool, it must be included by the \"Allow Path Patterns\" and not excluded by the \"Exclude Path Patterns\"."
		});
		note3El.style.marginTop = "14px";
		note3El.style.padding = "10px";
		note3El.style.borderLeft = "4px solid var(--interactive-accent)";
		note3El.style.backgroundColor = "var(--background-secondary)";
		note3El.style.fontSize = "0.85em";
		note3El.style.color = "var(--text-muted)";

		containerEl.createEl("h3", { text: "Cache Management" });

		const perfNote = containerEl.createEl("div", {
			text: "Note: Due to browser security constraints in Obsidian, local embedding generation is limited to a single CPU core. Initial indexing or re-indexing may be slow, but subsequent cached queries will be very fast."
		});
		perfNote.style.marginTop = "14px";
		perfNote.style.marginBottom = "14px";
		perfNote.style.padding = "10px";
		perfNote.style.borderLeft = "4px solid var(--interactive-accent)";
		perfNote.style.backgroundColor = "var(--background-secondary)";
		perfNote.style.fontSize = "0.85em";
		perfNote.style.color = "var(--text-muted)";

		new Setting(containerEl)
			.setDesc("Delete the stored embedding vectors from disk and re-index your files.")
			.addButton((button) =>
				button
					.setButtonText("Clear Cache")
					.setWarning()
					.onClick(async () => {
						const cachePath = `${this.plugin.getPluginDirRelative()}/embeddings-cache.json`;
						const adapter = this.plugin.app.vault.adapter;
						try {
							if (await adapter.exists(cachePath)) {
								await adapter.remove(cachePath);
							}
							await this.plugin.reinitializeSearchEngine();
							new Notice("Embeddings cache successfully cleared!");
						} catch (err) {
							console.error("[Second Brain MCP] Failed to clear embeddings cache:", err);
							new Notice("Failed to clear embeddings cache: " + err);
						}
					})
			);

		containerEl.createEl("h3", { text: "Reset Settings" });

		new Setting(containerEl)
			.setDesc("Restore all settings to their original factory defaults. This will reset the embedding model, custom paths, wiki purpose, and path pattern filters.")
			.addButton((button) =>
				button
					.setButtonText("Restore Defaults")
					.setWarning()
					.onClick(async () => {
						this.plugin.settings = {
							modelName: DEFAULT_SETTINGS.modelName,
							customModelName: DEFAULT_SETTINGS.customModelName,
							cachedModelName: DEFAULT_SETTINGS.cachedModelName,
							returnDiagnosticLogs: DEFAULT_SETTINGS.returnDiagnosticLogs,
							wikiPurpose: DEFAULT_SETTINGS.wikiPurpose,
							allowedPathPatterns: [...DEFAULT_SETTINGS.allowedPathPatterns],
							excludedPathPatterns: [...DEFAULT_SETTINGS.excludedPathPatterns]
						};
						await this.plugin.saveSettings();
						await this.plugin.reinitializeSearchEngine();
						new Notice("Second Brain MCP settings successfully restored to defaults!");
						this.display(); // Re-render settings tab UI to show default values immediately
					})
			);
	}
}

function stripFrontmatter(content: string): string {
	const trimmed = content.trim();
	if (trimmed.startsWith("---")) {
		const nextDashIndex = trimmed.indexOf("---", 3);
		if (nextDashIndex !== -1) {
			return trimmed.substring(nextDashIndex + 3).trim();
		}
	}
	return trimmed;
}

function dotProduct(a: number[], b: number[]): number {
	let sum = 0;
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) {
		sum += a[i] * b[i];
	}
	return sum;
}

declare module "obsidian" {
	interface App {
		plugins: {
			enabledPlugins: Set<string>;
		};
	}
	interface Workspace {
		on(
			name: "obsidian-local-rest-api:loaded",
			callback: () => void,
			ctx?: any
		): EventRef;
	}
}
