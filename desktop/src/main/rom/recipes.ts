import { OPENEMU_RECIPE, type RomRecipe } from './recipe';
import { OPENEMU_COMPAT_RECIPE } from './recipe-compat';

/**
 * Every ROM this build of the app can make, by id. The id is also the image's SDK tag, which is
 * how a profile names its ROM: `PROFILE_IMAGE_TAG=openemu-compat` selects the recipe of that id.
 */
export const ROM_RECIPES: Readonly<Record<string, RomRecipe>> = Object.freeze({
  [OPENEMU_RECIPE.id]: OPENEMU_RECIPE,
  [OPENEMU_COMPAT_RECIPE.id]: OPENEMU_COMPAT_RECIPE,
});

/** The recipe with this id, or null — an image tag that is not one of ours is a stock image. */
export function recipeById(id: string): RomRecipe | null {
  return Object.prototype.hasOwnProperty.call(ROM_RECIPES, id) ? ROM_RECIPES[id] : null;
}
