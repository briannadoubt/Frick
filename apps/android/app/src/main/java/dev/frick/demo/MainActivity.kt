package dev.frick.demo

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.frick.client.ConversationDto
import dev.frick.client.FrickClient
import dev.frick.client.FrickStreamEvent
import dev.frick.client.SQLiteFrickStorage
import dev.frick.client.UserDto
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)
        setContent {
            FrickTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    FrickDemo()
                }
            }
        }
    }
}

@Composable
fun FrickTheme(content: @Composable () -> Unit) {
    val colorScheme = if (isSystemInDarkTheme()) {
        darkColorScheme()
    } else {
        lightColorScheme()
    }

    MaterialTheme(
        colorScheme = colorScheme,
        content = content,
    )
}

@Composable
fun FrickDemo() {
    var users by remember { mutableStateOf<List<UserDto>>(emptyList()) }
    var conversations by remember { mutableStateOf<List<ConversationDto>>(emptyList()) }
    var messages by remember { mutableStateOf<List<FrickStreamEvent>>(emptyList()) }
    var draft by remember { mutableStateOf("") }
    var status by remember { mutableStateOf("Idle") }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current.applicationContext
    val frick = remember(context) { FrickClient(storage = SQLiteFrickStorage(context)) }
    val title = conversations.firstOrNull { conversation -> conversation.id == "conversation-general" }?.title
        ?: "Foundation General"

    suspend fun reload() {
        status = "Loading"
        try {
            users = frick.fetchUsers()
            conversations = frick.fetchConversations()
            messages = frick.fetchMessages()
            status = "Loaded"
        } catch (error: Exception) {
            status = error.localizedMessage ?: "Load failed"
        }
    }

    suspend fun send() {
        val body = draft.trim()
        if (body.isEmpty()) {
            return
        }
        draft = ""
        status = "Sending"
        try {
            frick.sendMessage(body = body)
            messages = frick.fetchMessages()
            status = "Synced"
        } catch (error: Exception) {
            status = error.localizedMessage ?: "Send failed"
        }
    }

    LaunchedEffect(Unit) {
        reload()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .safeDrawingPadding()
            .imePadding()
            .padding(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Header(
            title = title,
            status = status,
            onReload = { scope.launch { reload() } },
        )
        UsersRow(users = users)
        MessagesList(
            users = users,
            messages = messages,
            modifier = Modifier.weight(1f),
        )
        Composer(
            draft = draft,
            onDraftChange = { nextDraft -> draft = nextDraft },
            onSend = { scope.launch { send() } },
        )
    }
}

@Composable
private fun Header(
    title: String,
    status: String,
    onReload: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = status,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Button(onClick = onReload) {
            Text("Reload")
        }
    }
}

@Composable
private fun UsersRow(users: List<UserDto>) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        users.forEach { user ->
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    shape = MaterialTheme.shapes.small,
                ) {
                    Text(
                        text = initials(user.displayName),
                        modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                        color = MaterialTheme.colorScheme.onPrimaryContainer,
                        style = MaterialTheme.typography.labelMedium,
                        fontWeight = FontWeight.Black,
                    )
                }
                Text(
                    text = user.displayName,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                )
            }
        }
    }
}

@Composable
private fun MessagesList(
    users: List<UserDto>,
    messages: List<FrickStreamEvent>,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(messages, key = { message -> message.eventId }) { message ->
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Text(
                        text = displayName(users, message.payload["senderId"].orEmpty()),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = message.payload["body"].orEmpty(),
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
            }
        }
    }
}

@Composable
private fun Composer(
    draft: String,
    onDraftChange: (String) -> Unit,
    onSend: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        OutlinedTextField(
            value = draft,
            onValueChange = onDraftChange,
            modifier = Modifier.weight(1f),
            singleLine = true,
            label = { Text("Message the foundation") },
        )
        Button(onClick = onSend) {
            Text("Send")
        }
    }
}

private fun displayName(users: List<UserDto>, userId: String): String =
    users.firstOrNull { user -> user.id == userId }?.displayName ?: userId

private fun initials(name: String): String =
    name
        .split(" ")
        .mapNotNull { part -> part.firstOrNull()?.uppercaseChar() }
        .take(2)
        .joinToString("")
