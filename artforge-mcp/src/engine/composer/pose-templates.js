'use strict';
// Angles in screen radians; lengths use head units. Engineering defaults, not
// quotations from a reference book. FK preserves bone lengths for every template.
const templates = {
  standing: {torso:-Math.PI/2,arms:[1.45,1.7],forearms:[1.5,1.6],thighs:[1.48,1.66],shins:[1.57,1.57]},
  seated: {torso:-1.6,arms:[1.1,2.0],forearms:[0.1,3.0],thighs:[0.1,0.2],shins:[1.6,1.5]},
  reading: {torso:-1.65,arms:[1.05,2.1],forearms:[-0.3,3.4],thighs:[0.1,0.2],shins:[1.6,1.5]},
  walking: {torso:-1.5,arms:[1.1,2.1],forearms:[1.0,1.9],thighs:[1.05,2.0],shins:[1.4,1.9]},
  carrying: {torso:-1.6,arms:[1.0,2.1],forearms:[-0.7,3.8],thighs:[1.48,1.66],shins:[1.57,1.57]},
  desk: {torso:-1.45,arms:[0.9,1.0],forearms:[0.0,0.15],thighs:[0.05,0.15],shins:[1.6,1.5]},
  reclining: {torso:-Math.PI,arms:[0,0],forearms:[0,0],thighs:[0.05,-0.05],shins:[0,0]},
  bending: {torso:-0.6,arms:[1.3,1.6],forearms:[1.4,1.7],thighs:[1.4,1.8],shins:[1.7,1.5]},
};
module.exports={templates};
