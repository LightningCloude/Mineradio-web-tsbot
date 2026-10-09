//! Playback buffering primitives shared by the actual send loop and its tests.
use std::collections::VecDeque;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

pub fn drain_bounded(
    rx: &mut mpsc::Receiver<Vec<u8>>, queue: &mut VecDeque<Vec<u8>>,
    limit: usize, frame_bytes: usize,
) {
    // Bound attempts too: a stream of malformed frames cannot monopolise a tick.
    for _ in 0..limit {
        if queue.len() >= limit { break; }
        let Ok(frame) = rx.try_recv() else { break; };
        if frame.len() == frame_bytes { queue.push_back(frame); }
    }
}

pub fn ready(queue_len: usize, target: usize, closed: bool) -> bool {
    queue_len >= target || (closed && queue_len > 0)
}

pub async fn read_frame<R: AsyncRead + Unpin>(
    reader: &mut R, frame: &mut [u8], cancel: &CancellationToken,
) -> bool {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => false,
        result = reader.read_exact(frame) => result.is_ok(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[tokio::test]
    async fn buffer_backpressure_keeps_excess_frames_in_channel() {
        let (tx, mut rx) = mpsc::channel(10);
        for value in 0..8 { tx.send(vec![value; 4]).await.unwrap(); }
        let mut queue = VecDeque::new();
        drain_bounded(&mut rx, &mut queue, 3, 4);
        assert_eq!(queue.len(), 3);
        assert_eq!(rx.len(), 5);
        assert_eq!(queue.pop_front().unwrap(), vec![0; 4]);
        drain_bounded(&mut rx, &mut queue, 3, 4);
        assert_eq!(queue.len(), 3);
        assert_eq!(rx.len(), 4);
    }

    #[tokio::test]
    async fn malformed_frames_and_eof_do_not_hold_short_tail_in_prebuffer() {
        let (tx, mut rx) = mpsc::channel(10);
        tx.send(vec![1; 2]).await.unwrap();
        tx.send(vec![2; 4]).await.unwrap();
        drop(tx);
        let mut queue = VecDeque::new();
        drain_bounded(&mut rx, &mut queue, 3, 4);
        assert_eq!(queue.len(), 1);
        assert!(ready(queue.len(), 5, rx.is_closed()));
        assert!(!ready(0, 5, true));
    }

    #[tokio::test]
    async fn stalled_pcm_read_is_cancelled_without_waiting_for_ffmpeg() {
        let (mut reader, _writer) = tokio::io::duplex(16);
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(!tokio::time::timeout(std::time::Duration::from_millis(100),
            read_frame(&mut reader, &mut [0; 4], &cancel)).await.unwrap());
    }

    #[tokio::test]
    async fn complete_frame_is_read_and_partial_eof_is_not_encoded() {
        let (mut reader, mut writer) = tokio::io::duplex(16);
        writer.write_all(&[1, 2, 3, 4, 5]).await.unwrap();
        drop(writer);
        let mut frame = [0; 4];
        let cancel = CancellationToken::new();
        assert!(read_frame(&mut reader, &mut frame, &cancel).await);
        assert_eq!(frame, [1, 2, 3, 4]);
        assert!(!read_frame(&mut reader, &mut frame, &cancel).await);
    }
}
