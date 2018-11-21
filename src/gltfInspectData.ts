import * as vscode from 'vscode';
import * as path from 'path';
import { GltfWindow } from './gltfWindow';
import { GLTF2 } from './GLTF2';
import { getFromJsonPointer, getAccessorData, getAccessorElement, AccessorTypeToNumComponents } from './utilities';
import { sprintf } from 'sprintf-js';

enum NodeType {
    Header,
    DataGroup,
    AccessorScalar,
    AccessorVector,
    AccessorMatrix,
    AccessorMatrixRow,
    MatrixRow,
    Vertices,
    Vertex,
    VertexAttribute,
    Triangles,
    Triangle,
    Lines,
    Line,
    Points,
    Point
}

interface Node {
    type: NodeType;
}

interface DataGroupNode<T extends Node> extends Node {
    startIndex: number;
    endIndex: number;
    nodes: T[];
}

interface AccessorElementNode extends Node {
    index: number;
    float: boolean;
}

interface AccessorScalarNode extends AccessorElementNode {
    value: number;
}

interface AccessorVectorNode extends AccessorElementNode {
    values: number[];
}

interface AccessorMatrixNode extends AccessorElementNode {
    rows: AccessorMatrixRowNode[];
}

interface AccessorMatrixRowNode extends AccessorElementNode {
    values: number[];
}

interface VerticesNode extends Node {
    numVertices: number;
    nodes: DataGroupNode<VertexNode>[] | VertexNode[];
}

interface VertexNode extends Node {
    index: number;
    attributeNodes: VertexAttributeNode[];
}

interface VertexAttributeNode extends Node {
    name: string;
    values: number[];
}

interface TrianglesNode extends Node {
    nodes: DataGroupNode<TriangleNode>[] | TriangleNode[];
}

interface TriangleNode extends Node {
    indices: [number, number, number];
}

interface LinesNode extends Node {
    nodes: DataGroupNode<LineNode>[] | LineNode[];
}

interface LineNode extends Node {
    indices: [number, number];
}

interface PointsNode extends Node {
    nodes: DataGroupNode<PointNode>[] | PointNode[];
}

interface PointNode extends Node {
    index: number;
}

function formatScalar(value: number, float: boolean): string {
    return float ? sprintf('%.5f', value) : `${value}`;
}

function formatVector(values: number[], float: boolean): string {
    return `[${values.map(value => formatScalar(value, float)).join(', ')}]`;
}

function formatMatrix(rows: { values: number[] }[], float: boolean): string {
    return rows.map(row => formatVector(row.values, float)).join(', ');
}

function getDataNodes<T extends Node>(count: number, getNode: (index: number) => T): DataGroupNode<T>[] | T[] {
    const groupNodes: DataGroupNode<T>[] = [];
    for (let startIndex = 0, endIndex = 0; startIndex < count; startIndex = endIndex + 1) {
        endIndex = Math.min(startIndex + 100, count) - 1;
        const nodes: T[] = [];
        for (let index = startIndex; index <= endIndex; index++) {
            nodes.push(getNode(index));
        }
        groupNodes.push({
            type: NodeType.DataGroup,
            startIndex: startIndex,
            endIndex: endIndex,
            nodes: nodes
        });
    }

    return (groupNodes.length === 1 ? groupNodes[0].nodes : groupNodes);
}

function getAccessorNodes(fileName: string, gltf: GLTF2.GLTF, accessor: GLTF2.Accessor): DataGroupNode<AccessorElementNode>[] | AccessorElementNode[] {
    const data = getAccessorData(fileName, gltf, accessor);
    if (!data) {
        throw new Error('Unable to get accessor data');
    }

    return getDataNodes(accessor.count, index => {
        return getAccessorElementNode(accessor, data, index);
    });
}

function getAccessorElementNode(accessor: GLTF2.Accessor, data: ArrayLike<number>, index: number): AccessorElementNode {
    const numComponents = AccessorTypeToNumComponents[accessor.type];
    const values = getAccessorElement(data, index, numComponents, accessor.componentType, accessor.normalized);
    const float = accessor.componentType === GLTF2.AccessorComponentType.FLOAT || accessor.normalized;

    switch (accessor.type) {
        case GLTF2.AccessorType.SCALAR: {
            return {
                type: NodeType.AccessorScalar,
                index: index,
                float: float,
                value: values[0]
            } as AccessorScalarNode;
        }
        case GLTF2.AccessorType.VEC2:
        case GLTF2.AccessorType.VEC3:
        case GLTF2.AccessorType.VEC4: {
            return {
                type: NodeType.AccessorVector,
                index: index,
                float: float,
                values: values
            } as AccessorVectorNode;
        }
        case GLTF2.AccessorType.MAT2:
        case GLTF2.AccessorType.MAT3:
        case GLTF2.AccessorType.MAT4: {
            const size = Math.sqrt(numComponents);
            const rows: AccessorMatrixRowNode[] = [];
            for (let rowIndex = 0; rowIndex < size; rowIndex++) {
                const start = rowIndex * size;
                const end = start + size;
                rows.push({
                    type: NodeType.AccessorMatrixRow,
                    index: rowIndex,
                    float: float,
                    values: values.slice(start, end)
                });
            }
            return {
                type: NodeType.AccessorMatrix,
                index: index,
                float: float,
                rows: rows
            } as AccessorMatrixNode;
        }
    }

    throw new Error(`Invalid accessor type: ${accessor.type}`);
}

function getVerticesNode(fileName: string, gltf: GLTF2.GLTF, attributes: { [name: string]: number }): VerticesNode {
    const accessorInfo: {
        [name: string]: {
            data: ArrayLike<number>,
            numComponents: number,
            accessor: any
         }
    } = {};

    let numVertices = 0;

    for (const attribute in attributes) {
        const accessor = gltf.accessors[attributes[attribute]];
        const data = accessor && getAccessorData(fileName, gltf, accessor);
        if (!data) {
            continue;
        }

        if (attribute === "POSITION") {
            numVertices = accessor.count;
        }

        accessorInfo[attribute] = {
            data: data,
            numComponents: AccessorTypeToNumComponents[accessor.type],
            accessor: accessor
        };
    }

    const nodes = getDataNodes(numVertices, index => {
        const attributeNodes: VertexAttributeNode[] = [];
        for (const attribute in attributes) {
            const info = accessorInfo[attribute];
            attributeNodes.push({
                type: NodeType.VertexAttribute,
                name: attribute,
                values: getAccessorElement(info.data, index, info.numComponents, info.accessor.componentType, info.accessor.normalized)
            });
        }
        return {
            type: NodeType.Vertex,
            index: index,
            attributeNodes: attributeNodes
        } as VertexNode;
    });

    return {
        type: NodeType.Vertices,
        numVertices: numVertices,
        nodes: nodes
    };
}

function getTriangleNodes(numVertices: number, mode: GLTF2.MeshPrimitiveMode, data: ArrayLike<number> | undefined): DataGroupNode<TriangleNode>[] | TriangleNode[] {
    const get = data ? i => data[i] : i => i;
    const length = data ? data.length : numVertices;
    let nodes: TriangleNode[];

    switch (mode) {
        case GLTF2.MeshPrimitiveMode.TRIANGLES: {
            nodes = new Array(length / 3);
            for (let i = 0; i < nodes.length; i++) {
                nodes[i] = {
                    type: NodeType.Triangle,
                    indices: [
                        get(i * 3),
                        get(i * 3 + 1),
                        get(i * 3 + 2)
                    ]
                };
            }
            break;
        }
        case GLTF2.MeshPrimitiveMode.TRIANGLE_FAN: {
            nodes = new Array(length - 2);
            for (let i = 0; i < nodes.length; i++) {
                nodes[i] = {
                    type: NodeType.Triangle,
                    indices: [
                        get(0),
                        get(i + 1),
                        get(i + 2)
                    ]
                };
            }
            break;
        }
        case GLTF2.MeshPrimitiveMode.TRIANGLE_STRIP: {
            nodes = new Array(length - 2);
            for (let i = 0; i < nodes.length; i++) {
                const flip = (i & 1) === 1;
                nodes[i] = {
                    type: NodeType.Triangle,
                    indices: [
                        get(flip ? i + 2 : i),
                        get(i + 1),
                        get(flip ? i : i + 2)
                    ]
                };
            }
            break;
        }
    }

    return getDataNodes(nodes.length, index => nodes[index]);
}

function getLineNodes(numVertices: number, mode: GLTF2.MeshPrimitiveMode, data: ArrayLike<number> | undefined): DataGroupNode<LineNode>[] | LineNode[] {
    const get = data ? i => data[i] : i => i;
    const length = data ? data.length : numVertices;
    let nodes: LineNode[];

    switch (mode) {
        case GLTF2.MeshPrimitiveMode.LINES: {
            nodes = new Array(length / 2);
            for (let i = 0; i < nodes.length; i++) {
                nodes[i] = {
                    type: NodeType.Line,
                    indices: [
                        get(i * 2),
                        get(i * 2 + 1)
                    ]
                };
            }
            break;
        }
        case GLTF2.MeshPrimitiveMode.LINE_LOOP:
        case GLTF2.MeshPrimitiveMode.LINE_STRIP: {
            nodes = new Array(mode === GLTF2.MeshPrimitiveMode.LINE_LOOP ? length : length - 1);
            for (let i = 0; i < nodes.length; i++) {
                nodes[i] = {
                    type: NodeType.Line,
                    indices: [
                        get(i),
                        get((i + 1) % length)
                    ]
                };
            }
            break;
        }
    }

    return getDataNodes(nodes.length, index => nodes[index]);
}

function getPointNodes(numVertices: number, data: ArrayLike<number> | undefined): DataGroupNode<PointNode>[] | PointNode[] {
    const get = data ? i => data[i] : i => i;
    const nodes = new Array<PointNode>(data ? data.length : numVertices);
    for (let i = 0; i < nodes.length; i++) {
        nodes[i] = {
            type: NodeType.Point,
            index: get(i)
        }
    }

    return getDataNodes(nodes.length, index => nodes[index]);
}

function getIndicesNode(fileName: string, gltf: GLTF2.GLTF, numVertices: number, mode: GLTF2.MeshPrimitiveMode | undefined, indices: number | undefined): TrianglesNode | LinesNode | PointsNode {
    if (mode == undefined) {
        mode = GLTF2.MeshPrimitiveMode.TRIANGLES;
    }

    const accessor = indices != undefined && gltf.accessors[indices];
    const data = accessor && getAccessorData(fileName, gltf, accessor);
    switch (mode) {
        case GLTF2.MeshPrimitiveMode.TRIANGLES:
        case GLTF2.MeshPrimitiveMode.TRIANGLE_FAN:
        case GLTF2.MeshPrimitiveMode.TRIANGLE_STRIP: {
            return {
                type: NodeType.Triangles,
                nodes: getTriangleNodes(numVertices, mode, data)
            } as TrianglesNode;
        }
        case GLTF2.MeshPrimitiveMode.LINES:
        case GLTF2.MeshPrimitiveMode.LINE_LOOP:
        case GLTF2.MeshPrimitiveMode.LINE_STRIP: {
            return {
                type: NodeType.Lines,
                nodes: getLineNodes(numVertices, mode, data)
            } as LinesNode;
        }
        case GLTF2.MeshPrimitiveMode.POINTS: {
            return {
                type: NodeType.Points,
                nodes: getPointNodes(numVertices, data)
            } as PointsNode;
        }
        default: {
            throw new Error(`Invalid mesh primitive mode (${mode})`);
        }
    }
}

export class GltfInspectData implements vscode.TreeDataProvider<Node> {
    private readonly dataIcon: { light: string, dark: string };
    private _treeView: vscode.TreeView<Node>;
    private _fileName: string;
    private _jsonPointer: string;
    private _roots: Node[];

    private _onDidChangeTreeData: vscode.EventEmitter<Node | null> = new vscode.EventEmitter<Node | null>();

    constructor(private context: vscode.ExtensionContext, private gltfWindow: GltfWindow) {
        this.dataIcon = {
            light: this.context.asAbsolutePath(path.join('resources', 'light', 'data.svg')),
            dark: this.context.asAbsolutePath(path.join('resources', 'dark', 'data.svg'))
        };

        this.gltfWindow.onDidChangeActiveTextEditor(() => {
            this.reset();
        });
    }

    public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    public getTreeItem(node: Node): vscode.TreeItem {
        let treeItem: vscode.TreeItem;
        switch (node.type) {
            case NodeType.Header: {
                treeItem = new vscode.TreeItem(this._jsonPointer, vscode.TreeItemCollapsibleState.None);
                treeItem.iconPath = this.dataIcon;
                break;
            }
            case NodeType.DataGroup: {
                const groupNode = node as DataGroupNode<Node>;
                treeItem = new vscode.TreeItem(`[${groupNode.startIndex}..${groupNode.endIndex}]`, vscode.TreeItemCollapsibleState.Collapsed);
                break;
            }
            case NodeType.AccessorScalar: {
                const scalarNode = node as AccessorScalarNode;
                const label = formatScalar(scalarNode.value, scalarNode.float);
                treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                treeItem.tooltip = `${scalarNode.index}: ${label}`;
                break;
            }
            case NodeType.AccessorVector: {
                const vectorNode = node as AccessorVectorNode;
                const label = formatVector(vectorNode.values, vectorNode.float);
                treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                treeItem.tooltip = `${vectorNode.index}: ${label}`;
                break;
            }
            case NodeType.AccessorMatrix: {
                const matrixNode = node as AccessorMatrixNode;
                const label = formatMatrix(matrixNode.rows, matrixNode.float);
                treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
                treeItem.tooltip = `${matrixNode.index}: ${label}`;
                break;
            }
            case NodeType.AccessorMatrixRow: {
                const matrixRowNode = node as AccessorMatrixRowNode;
                const label = formatVector(matrixRowNode.values, matrixRowNode.float);
                treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                treeItem.tooltip = `${matrixRowNode.index}: ${label}`;
                break;
            }
            case NodeType.Vertices: {
                treeItem = new vscode.TreeItem('Vertices', vscode.TreeItemCollapsibleState.Collapsed);
                break;
            }
            case NodeType.Vertex: {
                const vertexNode = node as VertexNode;
                treeItem = new vscode.TreeItem(`${vertexNode.index}`, vscode.TreeItemCollapsibleState.Collapsed);
                // Adding a command so that it does not expand when clicking on the item.
                // See https://github.com/Microsoft/vscode/issues/34130#issuecomment-398783006.
                // The actual handling of selection is in onDidSelectionChange to support multiselect.
                treeItem.command = { title: '', command: 'gltf.noop' }
                break;
            }
            case NodeType.VertexAttribute: {
                const vertexAttributeNode = node as VertexAttributeNode;
                const label = `${vertexAttributeNode.name}: ${formatVector(vertexAttributeNode.values, true)}`;
                treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                break;
            }
            case NodeType.Triangles: {
                treeItem = new vscode.TreeItem('Triangles', vscode.TreeItemCollapsibleState.Collapsed);
                break;
            }
            case NodeType.Triangle: {
                const triangleNode = node as TriangleNode;
                const label = `${formatVector(triangleNode.indices, false)}`;
                treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                break;
            }
            case NodeType.Lines: {
                treeItem = new vscode.TreeItem('Lines', vscode.TreeItemCollapsibleState.Collapsed);
                break;
            }
            case NodeType.Line: {
                const lineNode = node as LineNode;
                const label = `${formatVector(lineNode.indices, false)}`;
                treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                break;
            }
            case NodeType.Points: {
                treeItem = new vscode.TreeItem('Points', vscode.TreeItemCollapsibleState.Collapsed);
                break;
            }
            case NodeType.Point: {
                const pointNode = node as PointNode;
                const label = `${pointNode.index}`;
                treeItem = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
                break;
            }
            default: {
                throw new Error('Invalid data node type');
            }
        }
        return treeItem;
    }

    public getParent(node: Node): undefined {
        return undefined;
    }

    public getChildren(node?: Node): Node[] {
        if (!node) {
            return this._roots || [];
        }

        switch (node.type) {
            case NodeType.AccessorMatrix: {
                const accessorMatrixNode = node as AccessorMatrixNode;
                return accessorMatrixNode.rows;
            }
            case NodeType.DataGroup: {
                const groupNode = node as DataGroupNode<Node>;
                return groupNode.nodes;
            }
            case NodeType.Vertices: {
                const verticesNode = node as VerticesNode;
                return verticesNode.nodes;
            }
            case NodeType.Vertex: {
                const vertexNode = node as VertexNode;
                return vertexNode.attributeNodes;
            }
            case NodeType.Triangles: {
                const trianglesNode = node as TrianglesNode;
                return trianglesNode.nodes;
            }
            case NodeType.Lines: {
                const linesNode = node as LinesNode;
                return linesNode.nodes;
            }
            case NodeType.Points: {
                const pointsNode = node as PointsNode;
                return pointsNode.nodes;
            }
        }

        return [];
    }

    public setTreeView(treeView: vscode.TreeView<Node>): void {
        this._treeView = treeView;
        this._treeView.onDidChangeSelection(e => this.onDidSelectionChange(e));
    }

    public showAccessor(fileName: string, gltf: GLTF2.GLTF, jsonPointer: string): void {
        this._fileName = fileName;
        this._jsonPointer = jsonPointer;

        const accessor = getFromJsonPointer(gltf, jsonPointer) as GLTF2.Accessor;

        const accessorNode: Node = {
            type: NodeType.Header
        };

        this._roots = [accessorNode, ...getAccessorNodes(fileName, gltf, accessor)];
        this._onDidChangeTreeData.fire();
        this._treeView.reveal(accessorNode, { select: false, focus: true });
    }

    public showMeshPrimitive(fileName: string, gltf: GLTF2.GLTF, jsonPointer: string): void {
        this._fileName = fileName;
        this._jsonPointer = jsonPointer;

        const meshPrimitive = getFromJsonPointer(gltf, jsonPointer) as GLTF2.MeshPrimitive;

        const meshPrimitiveNode: Node = {
            type: NodeType.Header
        };

        const verticesNode = getVerticesNode(this._fileName, gltf, meshPrimitive.attributes);
        const indicesNode = getIndicesNode(this._fileName, gltf, verticesNode.numVertices, meshPrimitive.mode, meshPrimitive.indices);
        this._roots = [meshPrimitiveNode, verticesNode, indicesNode ];
        this._onDidChangeTreeData.fire();
        this._treeView.reveal(meshPrimitiveNode, { select: false, focus: true });
    }

    private reset(): void {
        delete this._fileName;
        delete this._jsonPointer;
        delete this._roots;
        this._onDidChangeTreeData.fire();
    }

    private onDidSelectionChange(e: vscode.TreeViewSelectionChangeEvent<Node>): void {
        const panel = this.gltfWindow.getPreviewPanel(this._fileName);
        if (e.selection.length === 0) {
            panel.webview.postMessage({ command: 'clear' });
        }
        else {
            const vertices = e.selection.filter(node => node.type === NodeType.Vertex).map((node: VertexNode) => node.index);
            if (vertices.length > 10) {
                vscode.window.showWarningMessage('Too many vertices selected. Only first 10 are shown.');
                vertices.length = 10;
            }

            const triangles = e.selection.filter(node => node.type === NodeType.Triangle).map((node: TriangleNode) => node.indices);
            const lines = e.selection.filter(node => node.type === NodeType.Line).map((node: LineNode) => node.indices);
            const points = e.selection.filter(node => node.type === NodeType.Point).map((node: PointNode) => [node.index]);
            const trianglesLinesPoints = [...triangles, ...lines, ...points];
            if (trianglesLinesPoints.length > 10) {
                vscode.window.showWarningMessage('Too many triangles, lines, or points selected. Only first 10 are shown.');
                trianglesLinesPoints.length = 10;
            }

            if (vertices.length !== 0 || trianglesLinesPoints.length !== 0) {
                panel.webview.postMessage({ command: 'select', jsonPointer: this._jsonPointer, vertices: vertices, trianglesLinesPoints: trianglesLinesPoints });
            }
        }
    }
}
