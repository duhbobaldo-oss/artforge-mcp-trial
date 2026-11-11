'use strict';
const defaults=Object.freeze({anatomy:'legacy',worldCamera:false,artifactResources:true,projectBundle:true,generativeImages:false});
function status(){return {version:1,defaults:{...defaults},optIns:{anatomy:'artDirection.anatomy=rig-v1',worldCamera:'artDirection.world=true or perspective=three-point'},realProviderRequestEnablement:false};}
module.exports={status};
