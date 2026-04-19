// See https://svelte.dev/docs/kit/types#app.d.ts

import type { Octokit } from 'octokit';

// for information about these interfaces
declare global {
  namespace App {
    // interface Error {}
    interface Locals {
      octokit: Octokit;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }
}
