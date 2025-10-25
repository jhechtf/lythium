import { SvelteMap } from 'svelte/reactivity';

export type GroupDescriptor = {
  name: string;
  description?: string;
};

class CommandRegistry {
	map: SvelteMap<string, RegisterCommandArgs> = new SvelteMap();

  entities = $derived.by(() => Array.from(this.map.entries()));

  groups: Record<string, RegisterCommandArgs[]> = {};

	[Symbol.iterator]() {
		return this.map.entries();
	}

	get(commandId: string) {
		return this.map.get(commandId);
	}

  has(commandId: string) {
    return this.map.has(commandId);
  }

  addToGroup(commandId: string, group: string) {
    if(!this.has(commandId)) return;

  }

}

export const commands = new CommandRegistry();

export type RegisterCommandArgs = {
	command: string;
	handler: () => void | Promise<void>;
	title: string;
	description?: string;
	icon?: string;
};

export function registerCommand(args: RegisterCommandArgs) {
	if (!commands.map.has(args.command)) {
		commands.map.set(args.command, args);
	} else {
		console.error(`command "${args.command}" already registered`);
	}
}

registerCommand({
	command: 'editor.lookup.file',
	title: 'Lookup File',
	handler: () => {
		console.info('ya momma');
	}
});

registerCommand({
	command: 'editor.lookup.dir',
	title: 'Lookup Directory',
	handler: () => {
		console.info('ya momma');
	}
});
