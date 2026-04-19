import type { Preview } from '@storybook/sveltekit';
import './preview.css';

const preview: Preview = {
  parameters: {
    // docs: {
    //   theme: themes.dark,
    // },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
  },
};

export default preview;
