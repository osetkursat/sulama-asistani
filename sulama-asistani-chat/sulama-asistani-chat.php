<?php
/*
Plugin Name: Sulama Asistanı Chat
Description: Sulama Asistanı Node.js uygulamasını WordPress içine gömen basit shortcode eklentisi.
Version: 1.0
Author: Kursat + ChatGPT
*/

if ( ! defined( 'ABSPATH' ) ) {
    exit; // Direkt erişimi engelle
}

function sa_chat_shortcode( $atts ) {

    $atts = shortcode_atts( array(
        'height' => '80vh',
    ), $atts, 'sulama_asistani' );

    $iframe = '
    <div style="width: 100%; max-width: 900px; margin: 0 auto; height: '. esc_attr( $atts['height'] ) .'; border: 1px solid #ddd; border-radius: 12px; overflow: hidden;">
      <iframe 
        src="https://sulama-asistani.onrender.com" 
        style="width: 100%; height: 100%; border: none;"
        title="Sulama Asistanı">
      </iframe>
    </div>';

    return $iframe;
}

add_shortcode( 'sulama_asistani', 'sa_chat_shortcode' );
