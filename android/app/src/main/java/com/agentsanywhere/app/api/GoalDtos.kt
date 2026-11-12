package com.agentsanywhere.app.api
import org.json.JSONObject

data class RemoteGoal(val id:String,val objective:String,val status:String,val seconds:Long?,val tokens:Long?,val budget:Long?,val reason:String?)
data class RemoteGoalState(val sessionId:String,val revision:Long,val freshness:String,val actions:List<String>,val goal:RemoteGoal?,val lastOutcome:RemoteGoal?,val pendingOperationId:String?=null)
internal fun JSONObject.toGoal():RemoteGoal = RemoteGoal(getString("id"),getString("objective"),getString("status"),if(isNull("timeUsedSeconds"))null else optLong("timeUsedSeconds"),if(isNull("tokensUsed"))null else optLong("tokensUsed"),if(isNull("tokenBudget"))null else optLong("tokenBudget"),optString("lastReason").takeIf{it.isNotBlank()&&it!="null"})
internal fun JSONObject.toGoalState():RemoteGoalState {
 val a=optJSONObject("capabilities")?.optJSONArray("actions")
 return RemoteGoalState(getString("sessionId"),optLong("revision"),optString("freshness","unknown"),if(a==null)emptyList() else (0 until a.length()).map{a.getString(it)},optJSONObject("goal")?.toGoal(),optJSONObject("lastOutcome")?.toGoal(),optString("pendingOperationId").takeIf{it.isNotBlank()&&it!="null"})
}
