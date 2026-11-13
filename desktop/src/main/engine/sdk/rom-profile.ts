import type { GuestProfile } from '../env-file';
import type { RomParams, RomRecipe } from '../../rom/recipe';
import { recipeById } from '../../rom/recipes';
import type { GuestTuning } from './host';

/**
 * The ROM recipe a profile runs, or null when its image is a stock one downloaded as-is.
 *
 * A recipe's id is its image tag, so the profile names it with `PROFILE_IMAGE_TAG`. The profile
 * also states the base and the API level on its own, because the SDK paths and the download are
 * built from those before any recipe is consulted — and the two descriptions can drift. Running on
 * would read one image directory and build into another, so a disagreement fails here, naming both.
 */
export function recipeForProfile(profile: GuestProfile): RomRecipe | null {
  const recipe = recipeById(profile.imageTag);
  if (!recipe) {
    if (profile.baseImageTag) {
      throw new Error(
        `profile '${profile.name}' is built from the ${profile.baseImageTag} image, but no ROM recipe is called '${profile.imageTag}'`,
      );
    }
    return null;
  }
  if (recipe.baseTag !== profile.baseImageTag || recipe.apiLevel !== profile.apiLevel) {
    throw new Error(
      `profile '${profile.name}' says ${profile.imageTag} is API ${profile.apiLevel} built from ` +
        `${profile.baseImageTag ?? 'nothing'}, but its recipe is API ${recipe.apiLevel} built from ${recipe.baseTag}`,
    );
  }
  return recipe;
}

/**
 * What the ROM is told about the guest it will run in: the core count is the very number written
 * to `hw.cpu.ncore`, taken from the same tuning, so the ARM translator's cpuinfo lists the cores the
 * guest actually has.
 */
export function romParams(tuning: GuestTuning): RomParams {
  return { armCpuCores: tuning.cores };
}
