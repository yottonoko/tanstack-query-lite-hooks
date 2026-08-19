/** 開発時の警告を一度だけ出すための内部ヘルパー */
export declare function warnOnce(field: string, message: string): void;
export declare function warnUnsupportedOption(field: string, detail?: string): void;
export declare function warnUnsupportedResultProperty(field: string): void;
export declare function resetWarningsForTests(): void;
