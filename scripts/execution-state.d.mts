export function validateCompleted(units: {id:string;dependencies:string}[], completed:string[]): number;
export function dependencyIds(text: string): string[];
export function validateUnitGraph(units: {id:string;dependencies:string}[]): void;
export function readPlanUnits(plan?: string): {id:string;dependencies:string}[];
export function validateExecutionState(state: string, units: {id:string;dependencies:string}[]): number;
export function checkExecutionState(): number;
