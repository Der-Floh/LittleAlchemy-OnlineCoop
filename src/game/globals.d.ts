// What we rely on from Little Alchemy's own scripts (build 580: alchemy.580.js,
// dragNdrop.580.js). These globals only exist once the game has loaded, which
// GameAdapter.whenReady() checks at runtime before anything uses them.

export {};

declare global {
    // The game's save: recipe pairs and when each was made.
    interface LAHistory {
        parents: number[][];
        date: number[];
    }

    interface LAGame {
        history: LAHistory;
        progress: number[];
        prime: number[];
        hiddenElements?: number[];
        finalElements: number[];
        maxProgress?: number;
        initProgress(): void;
        checkIfNotAlreadyDone(pair: number[]): boolean;
        getFinalElements(): void;
        changeProgressCounter(): void;
        resetProgress(): void;
    }

    // A drop target; caches its own position.
    interface LADroppable {
        element: HTMLElement;
        position: { x: number; y: number } | null;
        _accept: (this: LADroppable, element: HTMLElement) => boolean;
    }

    interface LADroppableConstructor {
        prototype: LADroppable;
    }

    // An element on the canvas.
    interface LAWorkspaceBox {
        id: string | number;
        $el: JQuery;
        droppable: LADroppable | null;
        initEvents: (this: LAWorkspaceBox, ...args: unknown[]) => unknown;
    }

    interface LAWorkspaceBoxConstructor {
        prototype: LAWorkspaceBox;
    }

    // What the game's drag events (dragStart / dragMove / dragEnd) carry.
    interface LADrag {
        element: HTMLElement | null;
        position: { x: number; y: number };
        dragPoint?: { x: number; y: number };
        options?: { helper?: unknown };
    }

    interface LAWorkspace {
        el: HTMLElement;
        $el: JQuery;
        sex(pair: number[]): number[];
        add(elementId: number, position: { left: number; top: number }): LAWorkspaceBox;
        del(box: LAWorkspaceBox): void;
        clearSpecified(elements: JQuery): void;
        recalculateElements: (event?: Event) => void;
        hideUnderLibrary?: () => void;
        save: (event?: Event) => void;
    }

    interface LABases {
        loaded: boolean;
        base: Record<string, { parents?: number[][]; hidden?: boolean }>;
        names?: Record<number, string>;
        images?: Record<number, string>;
    }

    interface Window {
        jQuery: JQueryStatic;
        game: LAGame;
        workspace: LAWorkspace;
        library: { el: HTMLElement | null; reload(): void };
        storage: { updateHistory(): void; updateAchievements?: () => void };
        bases: LABases;
        achievements?: { data?: unknown; earnedList?: unknown[]; initialCheck?: () => void };
        loadingScreen?: { list?: string[]; hide(): void };
        settings?: { data?: { markFinalElements?: boolean } };
        WorkspaceBox: LAWorkspaceBoxConstructor;
        Droppable: LADroppableConstructor;
    }
}
