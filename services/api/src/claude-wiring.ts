/** Shared wiring for the API entry points: the Claude Agent SDK planner replaces the raw structured-output planner when the runtime is configured. */
import type {AgentOptions} from './agent-runs.js';
import {claudeAgentPlanner} from './claude-planner.js';
import {CLAUDE_RUNTIME,claudeRuntimeConfig,type ClaudeRuntimeConfig} from './claude-runtime.js';
import type {Services} from './routes.js';

/** Returns the runtime or undefined; a malformed configuration is surfaced by agentConfiguration() as 'blocked', never silently ignored here. */
export function claudeRuntime(env:NodeJS.ProcessEnv=process.env):ClaudeRuntimeConfig|undefined{try{return claudeRuntimeConfig(env);}catch{return undefined;}}
export function withClaudePlanner(services:Services,options:AgentOptions,env:NodeJS.ProcessEnv=process.env):AgentOptions{
 if(options.model||options.config?.runtime!==CLAUDE_RUNTIME)return options;
 const runtime=claudeRuntime(env);if(!runtime)return options;
 return {...options,model:claudeAgentPlanner(services,{...runtime,model:options.config.model})};
}
