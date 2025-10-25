import type { Preview } from '@storybook/sveltekit';
import './preview.css';
import { themes } from 'storybook/theming';

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
