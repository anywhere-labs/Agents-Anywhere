package com.agentsanywhere.app.ui.screens.sessiondetail
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.agentsanywhere.app.R
import com.agentsanywhere.app.api.RemoteGoalState

@Composable
internal fun SessionGoalPanel(state:RemoteGoalState?,busy:Boolean,onAction:(String,String?)->Unit) {
 val g=state?.goal
 var editing by remember(g?.id){mutableStateOf(false)}
 var resuming by remember(g?.id){mutableStateOf(false)}
 var draft by remember(g?.id){mutableStateOf("")}
 LaunchedEffect(g?.objective,busy) { if(editing && !busy && g?.objective==draft.trim())editing=false }
 if(g!=null) {
  val actions=if(state.freshness=="fresh")state.actions else emptyList()
  Row(Modifier.fillMaxWidth().padding(horizontal=12.dp),horizontalArrangement=Arrangement.spacedBy(4.dp)) {
   Text(stringResource(when(g.status){"active"->R.string.goal_active;"paused"->R.string.goal_paused;"blocked"->R.string.goal_blocked;"usageLimited"->R.string.goal_usage_limited;"budgetLimited"->R.string.goal_budget_limited;else->R.string.goal_title}),modifier=Modifier.padding(vertical=12.dp),style=MaterialTheme.typography.labelSmall)
   TextButton(onClick={draft=g.objective;editing=true},enabled=!busy&&"edit" in actions,modifier=Modifier.weight(1f)){Text(g.objective,maxLines=1)}
   if(g.budget!=null && g.tokens!=null && g.status in listOf("active","budgetLimited")) Text("${g.tokens?:0} / ${g.budget}",style=MaterialTheme.typography.labelSmall)
   if(g.status=="active"&&"pause" in actions)TextButton(onClick={onAction("pause",null)},enabled=!busy){Text(stringResource(R.string.goal_pause))}
   if(g.status in listOf("paused","blocked","usageLimited")&&"resume" in actions)TextButton(onClick={resuming=true},enabled=!busy){Text(stringResource(R.string.goal_resume))}
   if("clear" in actions)TextButton(onClick={onAction("clear",null)},enabled=!busy){Text(stringResource(R.string.goal_clear))}
  }
 }
 if(resuming)AlertDialog(onDismissRequest={resuming=false},title={Text(stringResource(R.string.goal_resume_title))},text={Text(g?.objective?:"",maxLines=4)},confirmButton={TextButton(onClick={onAction("resume",null);resuming=false},enabled=!busy){Text(stringResource(R.string.goal_resume))}},dismissButton={TextButton(onClick={resuming=false}){Text(stringResource(R.string.goal_cancel))}})
 if(editing)Dialog(onDismissRequest={if(!busy)editing=false},properties=DialogProperties(usePlatformDefaultWidth=false)) {
  Surface(Modifier.fillMaxSize()) {Column(Modifier.fillMaxSize().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
   Text(stringResource(R.string.goal_edit),style=MaterialTheme.typography.titleLarge)
   OutlinedTextField(draft,{draft=it},enabled=!busy,label={Text(stringResource(R.string.goal_objective))},modifier=Modifier.weight(1f).fillMaxWidth())
   Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.End){TextButton(onClick={editing=false}){Text(stringResource(R.string.goal_cancel))};Button(onClick={onAction("edit",draft.trim())},enabled=!busy&&draft.trim().isNotEmpty()&&draft.trim()!=g?.objective){Text(stringResource(R.string.goal_save))}}
  }}
 }
}
