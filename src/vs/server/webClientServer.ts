/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as url from 'url';
import * as util from 'util';
import * as cookie from 'cookie';
import * as crypto from 'crypto';
import parseForwardHeader = require('forwarded-parse');
import { isEqualOrParent, sanitizeFilePath } from 'vs/base/common/extpath';
import { getMediaMime } from 'vs/base/common/mime';
import { isLinux } from 'vs/base/common/platform';
import { URI, UriComponents } from 'vs/base/common/uri';
import { createRemoteURITransformer } from 'vs/server/remoteUriTransformer';
import { ILogService } from 'vs/platform/log/common/log';
import { IServerEnvironmentService } from 'vs/server/serverEnvironmentService';
import { extname, dirname, join, normalize } from 'vs/base/common/path';
import { FileAccess } from 'vs/base/common/network';
import { generateUuid } from 'vs/base/common/uuid';
import { cwd } from 'vs/base/common/process';
import { IProductService } from 'vs/platform/product/common/productService';
// eslint-disable-next-line code-import-patterns
import type { IWorkbenchConstructionOptions } from 'vs/workbench/workbench.web.api';
import { editorBackground, editorForeground } from 'vs/platform/theme/common/colorRegistry';
import { ClientTheme, getPathPrefix, WebManifest } from 'vs/server/common/net';
import { IServerThemeService } from 'vs/server/serverThemeService';
import { isFalsyOrWhitespace } from 'vs/base/common/strings';

const textMimeType = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.css': 'text/css',
	'.svg': 'image/svg+xml',
} as { [ext: string]: string | undefined };

/**
 * Serve a file at a given path or 404 if the file is missing.
 */
export async function serveFile(logService: ILogService, req: http.IncomingMessage, res: http.ServerResponse, filePath: string, responseHeaders: Record<string, string> = Object.create(null)): Promise<void> {
	try {
		const stat = await util.promisify(fs.stat)(filePath);

		// Check if file modified since
		const etag = `W/"${[stat.ino, stat.size, stat.mtime.getTime()].join('-')}"`; // weak validator (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/ETag)
		if (req.headers['if-none-match'] === etag) {
			res.writeHead(304);
			return res.end();
		}

		// Headers
		responseHeaders['Content-Type'] = textMimeType[extname(filePath)] || getMediaMime(filePath) || 'text/plain';
		responseHeaders['Etag'] = etag;

		res.writeHead(200, responseHeaders);

		// Data
		fs.createReadStream(filePath).pipe(res);
	} catch (error) {
		if (error.code !== 'ENOENT') {
			logService.error(error);
			console.error(error.toString());
		}

		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return res.end('Not found');
	}
}

const APP_ROOT = dirname(FileAccess.asFileUri('', require).fsPath);

export class WebClientServer {

	private _mapCallbackUriToRequestId: Map<string, UriComponents> = new Map();

	constructor (
		private readonly _connectionToken: string,
		private readonly _environmentService: IServerEnvironmentService,
		private readonly _logService: ILogService,
		private readonly _themeService: IServerThemeService,
		private readonly _productService: IProductService
	) { }

	/**
	 * @coder Patched to handle an arbitrary path depth, such as in Coder Enterprise.
	 */
	async handle(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {
		try {
			const pathname = parsedUrl.pathname!;
			const parsedPath = path.parse(pathname);
			const pathPrefix = getPathPrefix(pathname);

			if (['manifest.json', 'webmanifest.json'].includes(parsedPath.base)) {
				return this._handleManifest(req, res, parsedUrl);
			}

			if (['favicon.ico', 'code-192.png', 'code-512.png'].includes(parsedPath.base)) {
				// always serve icons/manifest, even without a token
				return serveFile(this._logService, req, res, join(APP_ROOT, 'resources', 'server', parsedPath.base));
			}

			if (parsedPath.base === this._environmentService.serviceWorkerFileName) {
				return serveFile(this._logService, req, res, this._environmentService.serviceWorkerPath, {
					'Service-Worker-Allowed': pathPrefix,
				});
			}

			if (parsedPath.dir.includes('/static/') && parsedPath.ext) {
				parsedUrl.pathname = pathname.substring(pathname.indexOf('/static/'));
				// always serve static requests, even without a token
				return this._handleStatic(req, res, parsedUrl);
			}

			if (parsedPath.base === 'callback') {
				// callback support
				return this._handleCallback(req, res, parsedUrl);
			}

			if (parsedPath.base === 'fetch-callback') {
				// callback fetch support
				return this._handleFetchCallback(req, res, parsedUrl);
			}

			if (pathname.endsWith('/')) {
				// the token handling is done inside the handler
				return this._handleRoot(req, res, parsedUrl);
			}

			const message = `"${parsedUrl.pathname}" not found.`;
			const error = new Error(message);
			req.emit('error', error);
			return;
		} catch (error) {
			console.log('VS CODE ERRORED');
			this._logService.error(error);
			console.error(error.toString());

			return this.serveError(req, res, 500, 'Internal Server Error.', parsedUrl);
		}
	}

	// private _hasCorrectTokenCookie(req: http.IncomingMessage): boolean {
	// 	const cookies = cookie.parse(req.headers.cookie || '');
	// 	return (cookies['vscode-tkn'] === this._connectionToken);
	// }

	private async fetchClientTheme(): Promise<ClientTheme> {
		await this._themeService.readyPromise;
		const theme = await this._themeService.fetchColorThemeData();

		return {
			backgroundColor: theme.getColor(editorBackground, true)!.toString(),
			foregroundColor: theme.getColor(editorForeground, true)!.toString(),
		};
	}

	/**
	 * A convenience method which creates a URL prefixed with a relative path.
	 */
	private createRequestUrl(req: http.IncomingMessage, parsedUrl: url.UrlWithParsedQuery, pathname: string): URL {
		const pathPrefix = getPathPrefix(parsedUrl.pathname!);
		const remoteAuthority = this.getRemoteAuthority(req);
		return new URL(path.join('/', pathPrefix, pathname), remoteAuthority);
	}

	private _iconSizes = [192, 512];

	private getRemoteAuthority(req: http.IncomingMessage): URL {
		if (req.headers.forwarded) {
			const [parsedHeader] = parseForwardHeader(req.headers.forwarded);
			return new URL(`${parsedHeader.proto}://${parsedHeader.host}`);
		}

		/* Return first non-empty header. */
		const parseHeaders = (headerNames: string[]): string | undefined => {
			for (const headerName of headerNames) {
				const header = req.headers[headerName]?.toString();
				if (!isFalsyOrWhitespace(header)) {
					return header;
				}
			}
			return undefined;
		};

		const proto = parseHeaders(['X-Forwarded-Proto']) || 'http';
		const host = parseHeaders(['X-Forwarded-Host', 'host']) || 'localhost';

		return new URL(`${proto}://${host}`);
	}

	/**
	 * PWA manifest file. This informs the browser that the app may be installed.
	 */
	private async _handleManifest(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {
		const pathPrefix = getPathPrefix(parsedUrl.pathname!);
		const clientTheme = await this.fetchClientTheme();
		const startUrl = pathPrefix.substring(
			0,
			pathPrefix.lastIndexOf('/') + 1
		);

		const webManifest: WebManifest = {
			name: this._productService.nameLong,
			short_name: this._productService.nameShort,
			start_url: normalize(startUrl),
			display: 'fullscreen',
			'background-color': clientTheme.backgroundColor,
			description: 'Run editors on a remote server.',
			icons: this._iconSizes.map((size => ({
				src: this.createRequestUrl(req, parsedUrl, `/static/resources/server/code-${size}.png`).toString(),
				type: 'image/png',
				sizes: `${size}x${size}`,
			})))
		};

		res.writeHead(200, { 'Content-Type': 'application/manifest+json' });

		return res.end(JSON.stringify(webManifest, null, 2));
	}

	/**
	 * Handle HTTP requests for /static/*
	 */
	private async _handleStatic(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {
		const headers: Record<string, string> = Object.create(null);

		// Strip `/static/` from the path
		const normalizedPathname = decodeURIComponent(parsedUrl.pathname!); // support paths that are uri-encoded (e.g. spaces => %20)
		const relativeFilePath = normalize(normalizedPathname.substr('/static/'.length));

		const filePath = join(APP_ROOT, relativeFilePath);
		if (!isEqualOrParent(filePath, APP_ROOT, !isLinux)) {
			return this.serveError(req, res, 400, `Bad request.`, parsedUrl);
		}

		return serveFile(this._logService, req, res, filePath, headers);
	}

	/**
	 * Handle HTTP requests for /
	 */
	private async _handleRoot(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {
		if (!req.headers.host) {
			return this.serveError(req, res, 400, `Bad request.`, parsedUrl);
		}

		const { backgroundColor, foregroundColor } = await this.fetchClientTheme();

		const queryTkn = parsedUrl.query['tkn'];
		if (typeof queryTkn === 'string') {
			// tkn came in via a query string
			// => set a cookie and redirect to url without tkn
			const responseHeaders: Record<string, string> = Object.create(null);
			responseHeaders['Set-Cookie'] = cookie.serialize('vscode-tkn', queryTkn, { sameSite: 'strict', maxAge: 60 * 60 * 24 * 7 /* 1 week */ });

			const newQuery = Object.create(null);
			for (let key in parsedUrl.query) {
				if (key !== 'tkn') {
					newQuery[key] = parsedUrl.query[key];
				}
			}
			const newLocation = url.format({ pathname: '/', query: newQuery });
			responseHeaders['Location'] = newLocation;

			res.writeHead(302, responseHeaders);
			return res.end();
		}

		// NOTE@coder: Disable until supported (currently this results in 403 errors
		// in production builds and we already have authentication).
		// if (this._environmentService.isBuilt && !this._hasCorrectTokenCookie(req)) {
		// 	return this.serveError(req, res, 403, `Forbidden.`, parsedUrl);
		// }

		const remoteAuthority = this.getRemoteAuthority(req);

		const transformer = createRemoteURITransformer(remoteAuthority.host);
		const { workspacePath, isFolder } = await this._getWorkspaceFromCLI();

		function escapeAttribute(value: string): string {
			return value.replace(/"/g, '&quot;');
		}

		let _wrapWebWorkerExtHostInIframe: undefined | false = undefined;
		if (this._environmentService.driverHandle) {
			// integration tests run at a time when the built output is not yet published to the CDN
			// so we must disable the iframe wrapping because the iframe URL will give a 404
			_wrapWebWorkerExtHostInIframe = false;
		}

		const filePath = FileAccess.asFileUri(this._environmentService.isBuilt ? 'vs/code/browser/workbench/workbench.html' : 'vs/code/browser/workbench/workbench-dev.html', require).fsPath;
		const authSessionInfo = !this._environmentService.isBuilt && this._environmentService.args['github-auth'] ? {
			id: generateUuid(),
			providerId: 'github',
			accessToken: this._environmentService.args['github-auth'],
			scopes: [['user:email'], ['repo']]
		} : undefined;

		const data = (await util.promisify(fs.readFile)(filePath)).toString()
			.replace('{{WORKBENCH_WEB_CONFIGURATION}}', escapeAttribute(JSON.stringify(<IWorkbenchConstructionOptions>{
				productConfiguration: {
					...this._productService,

					// Session
					auth: this._environmentService.auth,

					// Service Worker
					serviceWorker: {
						scope: './',
						url: `./${this._environmentService.serviceWorkerFileName}`
					},

					// Endpoints
					logoutEndpointUrl: this.createRequestUrl(req, parsedUrl, '/logout').toString(),
					webEndpointUrl: this.createRequestUrl(req, parsedUrl, '/static').toString(),
					webEndpointUrlTemplate: this.createRequestUrl(req, parsedUrl, '/static').toString(),

					updateUrl: this.createRequestUrl(req, parsedUrl, '/update/check').toString(),
				},
				folderUri: (workspacePath && isFolder) ? transformer.transformOutgoing(URI.file(workspacePath)) : undefined,
				workspaceUri: (workspacePath && !isFolder) ? transformer.transformOutgoing(URI.file(workspacePath)) : undefined,
				// Add port to prevent client-side mismatch for reverse proxies.
				remoteAuthority: `${remoteAuthority.hostname}:${remoteAuthority.port || (remoteAuthority.protocol === 'https:' ? '443' : '80')}`,
				_wrapWebWorkerExtHostInIframe,
				developmentOptions: {
					enableSmokeTestDriver: this._environmentService.driverHandle === 'web' ? true : undefined,
					logLevel: this._logService.getLevel(),
				},
				settingsSyncOptions: !this._environmentService.isBuilt && this._environmentService.args['enable-sync'] ? { enabled: true } : undefined,
			})))
			.replace(/{{CLIENT_BACKGROUND_COLOR}}/g, () => backgroundColor)
			.replace(/{{CLIENT_FOREGROUND_COLOR}}/g, () => foregroundColor)
			.replace('{{WORKBENCH_AUTH_SESSION}}', () => authSessionInfo ? escapeAttribute(JSON.stringify(authSessionInfo)) : '');

		const cspDirectives = [
			'default-src \'self\';',
			'img-src \'self\' https: data: blob:;',
			'media-src \'none\';',
			// the sha is the same as in src/vs/workbench/services/extensions/worker/webWorkerExtensionHostIframe.html
			`script-src 'self' 'unsafe-eval' ${this._getScriptCspHashes(data).join(' ')} 'sha256-cb2sg39EJV8ABaSNFfWu/ou8o1xVXYK7jp90oZ9vpcg=';`,
			'child-src \'self\';',
			`frame-src 'self' https://*.vscode-webview.net ${this._productService.webEndpointUrl || ''} data:;`,
			'worker-src \'self\' data:;',
			'style-src \'self\' \'unsafe-inline\';',
			'connect-src \'self\' ws: wss: https:;',
			'font-src \'self\' blob:;',
			'manifest-src \'self\' https://cloud.coder.com https://github.com;'
		].join(' ');

		res.writeHead(200, {
			'Content-Type': 'text/html',
			// At this point we know the client has a valid cookie
			// and we want to set it prolong it to ensure that this
			// client is valid for another 1 week at least
			'Set-Cookie': cookie.serialize('vscode-tkn', this._connectionToken, { sameSite: 'strict', maxAge: 60 * 60 * 24 * 7 /* 1 week */ }),
			'Content-Security-Policy': cspDirectives
		});
		return res.end(data);
	}

	private _getScriptCspHashes(content: string): string[] {
		// Compute the CSP hashes for line scripts. Uses regex
		// which means it isn't 100% good.
		const regex = /<script>([\s\S]+?)<\/script>/img;
		const result: string[] = [];
		let match: RegExpExecArray | null;
		while (match = regex.exec(content)) {
			const hasher = crypto.createHash('sha256');
			// This only works on Windows if we strip `\r` from `\r\n`.
			const script = match[1].replace(/\r\n/g, '\n');
			const hash = hasher
				.update(Buffer.from(script))
				.digest().toString('base64');

			result.push(`'sha256-${hash}'`);
		}
		return result;
	}

	private async _getWorkspaceFromCLI(): Promise<{ workspacePath?: string, isFolder?: boolean }> {

		// check for workspace argument
		const workspaceCandidate = this._environmentService.args['workspace'];
		if (workspaceCandidate && workspaceCandidate.length > 0) {
			const workspace = sanitizeFilePath(workspaceCandidate, cwd());
			if (await util.promisify(fs.exists)(workspace)) {
				return { workspacePath: workspace };
			}
		}

		// check for folder argument
		const folderCandidate = this._environmentService.args['folder'];
		if (folderCandidate && folderCandidate.length > 0) {
			const folder = sanitizeFilePath(folderCandidate, cwd());
			if (await util.promisify(fs.exists)(folder)) {
				return { workspacePath: folder, isFolder: true };
			}
		}

		// empty window otherwise
		return {};
	}

	private _getFirstQueryValue(parsedUrl: url.UrlWithParsedQuery, key: string): string | undefined {
		const result = parsedUrl.query[key];
		return Array.isArray(result) ? result[0] : result;
	}

	private _getFirstQueryValues(parsedUrl: url.UrlWithParsedQuery, ignoreKeys?: string[]): Map<string, string> {
		const queryValues = new Map<string, string>();

		for (const key in parsedUrl.query) {
			if (ignoreKeys && ignoreKeys.indexOf(key) >= 0) {
				continue;
			}

			const value = this._getFirstQueryValue(parsedUrl, key);
			if (typeof value === 'string') {
				queryValues.set(key, value);
			}
		}

		return queryValues;
	}

	/**
	 * Handle HTTP requests for /callback
	 */
	private async _handleCallback(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {
		const wellKnownKeys = ['vscode-requestId', 'vscode-scheme', 'vscode-authority', 'vscode-path', 'vscode-query', 'vscode-fragment'];
		const [requestId, vscodeScheme, vscodeAuthority, vscodePath, vscodeQuery, vscodeFragment] = wellKnownKeys.map(key => {
			const value = this._getFirstQueryValue(parsedUrl, key);
			if (value) {
				return decodeURIComponent(value);
			}

			return value;
		});

		if (!requestId) {
			res.writeHead(400, { 'Content-Type': 'text/plain' });
			return res.end(`Bad request.`);
		}

		// merge over additional query values that we got
		let query: string | undefined = vscodeQuery;
		let index = 0;
		this._getFirstQueryValues(parsedUrl, wellKnownKeys).forEach((value, key) => {
			if (!query) {
				query = '';
			}

			const prefix = (index++ === 0) ? '' : '&';
			query += `${prefix}${key}=${value}`;
		});

		// add to map of known callbacks
		this._mapCallbackUriToRequestId.set(requestId, URI.from({ scheme: vscodeScheme || this._productService.urlProtocol, authority: vscodeAuthority, path: vscodePath, query, fragment: vscodeFragment }).toJSON());

		return serveFile(this._logService, req, res, FileAccess.asFileUri('vs/code/browser/workbench/callback.html', require).fsPath, { 'Content-Type': 'text/html' });
	}

	/**
	 * Handle HTTP requests for /fetch-callback
	 */
	private async _handleFetchCallback(req: http.IncomingMessage, res: http.ServerResponse, parsedUrl: url.UrlWithParsedQuery): Promise<void> {
		const requestId = this._getFirstQueryValue(parsedUrl, 'vscode-requestId')!;
		if (!requestId) {
			res.writeHead(400, { 'Content-Type': 'text/plain' });
			return res.end(`Bad request.`);
		}

		const knownCallbackUri = this._mapCallbackUriToRequestId.get(requestId);
		if (knownCallbackUri) {
			this._mapCallbackUriToRequestId.delete(requestId);
		}

		res.writeHead(200, { 'Content-Type': 'text/json' });
		return res.end(JSON.stringify(knownCallbackUri));
	}

	serveError = async (_req: http.IncomingMessage, res: http.ServerResponse, code: number, message: string, parsedUrl?: url.UrlWithParsedQuery): Promise<void> => {
		const { applicationName, commit = 'development', version } = this._productService;

		res.statusCode = code;
		res.statusMessage = message;

		if (parsedUrl) {
			this._logService.debug(`[${parsedUrl.toString()}] ${code}: ${message}`);

			if (parsedUrl.pathname?.endsWith('.json')) {
				res.setHeader('Content-Type', 'application/json');

				res.end(JSON.stringify({ code, message, commit }));
				return;
			}
		}

		const clientTheme = await this.fetchClientTheme();

		res.setHeader('Content-Type', 'text/html');

		const filePath = FileAccess.asFileUri('vs/code/browser/workbench/workbench-error.html', require).fsPath;
		const data = (await util.promisify(fs.readFile)(filePath)).toString()
			.replace(/{{ERROR_HEADER}}/g, () => `${applicationName}`)
			.replace(/{{ERROR_CODE}}/g, () => code.toString())
			.replace(/{{ERROR_MESSAGE}}/g, () => message)
			.replace(/{{ERROR_FOOTER}}/g, () => `${version} - ${commit}`)
			.replace(/{{CLIENT_BACKGROUND_COLOR}}/g, () => clientTheme.backgroundColor)
			.replace(/{{CLIENT_FOREGROUND_COLOR}}/g, () => clientTheme.foregroundColor);

		res.end(data);
	};
}
