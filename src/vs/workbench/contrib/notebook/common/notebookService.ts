/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from 'vs/platform/instantiation/common/instantiation';
import { URI } from 'vs/base/common/uri';
import { NotebookProviderInfo } from 'vs/workbench/contrib/notebook/common/notebookProvider';
import { NotebookExtensionDescription } from 'vs/workbench/api/common/extHost.protocol';
import { Event } from 'vs/base/common/event';
import { INotebookTextModel, INotebookRendererInfo, INotebookKernelProvider, INotebookKernel, NotebookDataDto, TransientOptions, INotebookExclusiveDocumentFilter, IOrderedMimeType, IOutputDto, INotebookMarkdownRendererInfo } from 'vs/workbench/contrib/notebook/common/notebookCommon';
import { NotebookTextModel } from 'vs/workbench/contrib/notebook/common/model/notebookTextModel';
import { CancellationToken } from 'vs/base/common/cancellation';
import { NotebookCellTextModel } from 'vs/workbench/contrib/notebook/common/model/notebookCellTextModel';
import { IDisposable } from 'vs/base/common/lifecycle';
import { NotebookOutputRendererInfo } from 'vs/workbench/contrib/notebook/common/notebookOutputRenderer';
import { IRelativePattern } from 'vs/base/common/glob';
import { VSBuffer } from 'vs/base/common/buffer';


export const INotebookService = createDecorator<INotebookService>('notebookService');

export interface IMainNotebookController {
	viewOptions?: { displayName: string; filenamePattern: (string | IRelativePattern | INotebookExclusiveDocumentFilter)[]; exclusive: boolean; };
	options: TransientOptions;
	resolveNotebookEditor(viewType: string, uri: URI, editorId: string): Promise<void>;
	onDidReceiveMessage(editorId: string, rendererType: string | undefined, message: any): void;

	openNotebook(viewType: string, uri: URI, backupId: string | undefined, token: CancellationToken, untitledDocumentData?: VSBuffer): Promise<{ data: NotebookDataDto, transientOptions: TransientOptions; }>;
	save(uri: URI, token: CancellationToken): Promise<boolean>;
	saveAs(uri: URI, target: URI, token: CancellationToken): Promise<boolean>;
	backup(uri: URI, token: CancellationToken): Promise<string>;
}

export interface INotebookSerializer {
	options: TransientOptions;
	dataToNotebook(data: Uint8Array): Promise<NotebookDataDto>
	notebookToData(data: NotebookDataDto): Promise<Uint8Array>;
}

export interface INotebookRawData {
	data: NotebookDataDto;
	transientOptions: TransientOptions;
}

export interface INotebookService {
	readonly _serviceBrand: undefined;
	canResolve(viewType: string): Promise<boolean>;

	onDidRemoveNotebookDocument: Event<URI>;
	onDidAddNotebookDocument: Event<NotebookTextModel>;
	onNotebookDocumentSaved: Event<URI>;
	onDidChangeKernels: Event<URI | undefined>;
	onDidChangeNotebookActiveKernel: Event<{ uri: URI, providerHandle: number | undefined, kernelFriendlyId: string | undefined; }>;

	registerNotebookController(viewType: string, extensionData: NotebookExtensionDescription, controller: IMainNotebookController): IDisposable;
	registerNotebookSerializer(viewType: string, serializer: INotebookSerializer): IDisposable;

	getMimeTypeInfo(textModel: NotebookTextModel, output: IOutputDto): readonly IOrderedMimeType[];

	registerNotebookKernelProvider(provider: INotebookKernelProvider): IDisposable;
	getNotebookKernels(viewType: string, resource: URI, token: CancellationToken): Promise<INotebookKernel[]>;
	getContributedNotebookKernelProviders(): Promise<INotebookKernelProvider[]>;
	getContributedNotebookOutputRenderers(id: string): NotebookOutputRendererInfo | undefined;
	getRendererInfo(id: string): INotebookRendererInfo | undefined;
	getMarkdownRendererInfo(): INotebookMarkdownRendererInfo[];

	createNotebookTextModel(viewType: string, uri: URI, data: NotebookDataDto, transientOptions: TransientOptions): NotebookTextModel;
	getNotebookTextModel(uri: URI): NotebookTextModel | undefined;
	getNotebookTextModels(): Iterable<NotebookTextModel>;
	listNotebookDocuments(): readonly NotebookTextModel[];

	getContributedNotebookProviders(resource?: URI): readonly NotebookProviderInfo[];
	getContributedNotebookProvider(viewType: string): NotebookProviderInfo | undefined;
	getNotebookProviderResourceRoots(): URI[];
	destoryNotebookDocument(viewType: string, notebook: INotebookTextModel): void;

	fetchNotebookRawData(viewType: string, uri: URI, backupId: string | undefined, token: CancellationToken, untitledDocumentData?: VSBuffer): Promise<INotebookRawData>;
	save(viewType: string, resource: URI, token: CancellationToken): Promise<boolean>;
	saveAs(viewType: string, resource: URI, target: URI, token: CancellationToken): Promise<boolean>;
	backup(viewType: string, uri: URI, token: CancellationToken): Promise<string | undefined>;

	onDidReceiveMessage(viewType: string, editorId: string, rendererType: string | undefined, message: unknown): void;
	setToCopy(items: NotebookCellTextModel[], isCopy: boolean): void;
	getToCopy(): { items: NotebookCellTextModel[], isCopy: boolean; } | undefined;

	// editor events

	resolveNotebookEditor(viewType: string, uri: URI, editorId: string): Promise<void>;
}
